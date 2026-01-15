import { Config } from './config';
import { Message, MessageReader, MessageWriter } from './protocol';

export type MessageHandler = (message: Message) => Promise<void> | void;

type QueuedMessage = Omit<Message, 'id'> & { id?: number };

export class Agent {
  private _ws: WebSocket | null = null;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = 10;
  private _reconnectDelay = 1000;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _manuallyDisconnected = false;
  private _connectionPromise: Promise<void> | null = null;
  private _messageReader = new MessageReader();
  private _messageWriter = new MessageWriter();
  private _messageQueue: QueuedMessage[] = [];
  private _processingMessages = false;

  readonly autoConnect: boolean;

  onMessage: MessageHandler | null = null;

  constructor(
    private _config: Config,
    private _options: {
      lookupKey: string;
      onMessage?: MessageHandler;
      autoConnect?: boolean;
    }
  ) {
    this.onMessage = this._options.onMessage ?? null;
    this.autoConnect = this._options.autoConnect ?? true;
  }

  /**
   * Connect to the agent WebSocket endpoint
   * @returns Promise that resolves when connection is established
   */
  async connect(): Promise<void> {
    if (this._ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this._connectionPromise) {
      return this._connectionPromise;
    }

    this._manuallyDisconnected = false;
    this._connectionPromise = this._performConnect();

    try {
      await this._connectionPromise;
    } finally {
      this._connectionPromise = null;
    }
  }

  /**
   * Disconnect from the agent WebSocket
   */
  async disconnect(): Promise<void> {
    this._manuallyDisconnected = true;
    this._clearReconnectTimer();

    if (this._ws) {
      if (
        this._ws.readyState !== WebSocket.CLOSING &&
        this._ws.readyState !== WebSocket.CLOSED
      ) {
        this._ws.close(1000, 'Client disconnect');
      }
      this._ws = null;
    }
  }

  /**
   * Check if the connection is active
   * @returns true if WebSocket is connected and ready
   */
  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Check if currently connecting
   * @returns true if a connection attempt is in progress
   */
  get connecting(): boolean {
    return this._connectionPromise !== null;
  }

  /**
   * Check if currently reconnecting
   * @returns true if reconnecting after a connection failure
   */
  get reconnecting(): boolean {
    return this.connecting && this._reconnectAttempts > 0;
  }

  private async _performConnect(): Promise<void> {
    const url = this._config.serviceUrl
      .replace('http://', 'ws://')
      .replace('https://', 'wss://');
    const targetUrl = `${url}/agent/live/${this._options.lookupKey}`;

    return new Promise((resolve, reject) => {
      try {
        // Clean up existing connection if any
        if (this._ws) {
          if (
            this._ws.readyState !== WebSocket.CLOSING &&
            this._ws.readyState !== WebSocket.CLOSED
          ) {
            this._ws.close();
          }
          this._ws = null;
        }

        const params = new URLSearchParams();
        params.set('pid', this._config.projectId);

        this._ws = new WebSocket(`${targetUrl}?${params.toString()}`);

        this._ws.onopen = () => {
          this._reconnectAttempts = 0;
          this._reconnectDelay = 1000;
          this._messageReader.reset();
          this._messageWriter.reset();
          this._flushMessageQueue();
          resolve();
        };

        this._ws.onmessage = event => {
          this._handleIncomingMessage(event.data);
        };

        this._ws.onerror = () => {
          reject(new Error('WebSocket connection error'));
        };

        this._ws.onclose = event => {
          this._ws = null;

          // Reconnect if the connection was not closed cleanly and we haven't exceeded max attempts
          if (
            !this._manuallyDisconnected &&
            event.code !== 1000 &&
            this._reconnectAttempts < this._maxReconnectAttempts
          ) {
            this._attemptReconnect();
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private _attemptReconnect(): void {
    this._clearReconnectTimer();

    this._reconnectAttempts++;
    const delay = Math.min(
      this._reconnectDelay * 2 ** (this._reconnectAttempts - 1),
      30000 // Max delay of 30 seconds
    );

    console.log(
      `Attempting to reconnect to agent (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts}) in ${delay}ms`
    );

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(error => {
        console.error('Reconnection failed:', error);
      });
    }, delay);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _handleIncomingMessage(data: string | ArrayBuffer | Blob): void {
    if (data instanceof ArrayBuffer) {
      const chunk = new Uint8Array(data);
      this._messageReader.push(chunk);
      this._processReceivedMessages();
    } else if (data instanceof Blob) {
      data.arrayBuffer().then(buffer => {
        const chunk = new Uint8Array(buffer);
        this._messageReader.push(chunk);
        this._processReceivedMessages();
      });
    }
  }

  private async _processReceivedMessages(): Promise<void> {
    if (this._processingMessages) {
      return;
    }
    this._processingMessages = true;
    try {
      while (this._messageReader.hasMessages) {
        const message = this._messageReader.poll();
        if (!message) {
          break;
        }

        if (this.onMessage) {
          try {
            await this.onMessage(message);
          } catch (error) {
            console.error('Error processing message:', error);
          }
        }
      }
    } finally {
      this._processingMessages = false;
    }
  }

  /**
   * Send a message to the agent
   * @param message - The message to send
   * @returns true if message was sent, false if queued due to connection failure
   */
  async send(message: QueuedMessage): Promise<boolean> {
    if (this.autoConnect && !this.connected) {
      this.connect().catch(() => {
        // no-op
      });
    }

    if (!this.connected) {
      this._messageQueue.push(message);
      return false;
    }

    try {
      const frames = this._messageWriter.write(message);
      for (const frame of frames) {
        this._ws!.send(frame);
      }
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      this._messageQueue.push(message);
      return false;
    }
  }

  private async _flushMessageQueue(): Promise<void> {
    if (this._messageQueue.length === 0) {
      return;
    }

    const queue = [...this._messageQueue];
    this._messageQueue = [];

    for (const message of queue) {
      await this.send(message);
    }
  }
}
