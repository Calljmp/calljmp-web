// Binary Header Structure (Fixed 10 bytes, big-endian)
// - Byte 0: Version (uint8, e.g., 1)
// - Bytes 1-2: Flags (uint16; bit 0: isFirst, bit 1: isLast, reserved for compression etc.)
// - Bytes 3-6: Message ID (uint32, sequential for ordering and multi-frame assembly)
// - Byte 7: Type Code (uint8, from MessageTypeCode enum)
// - Bytes 8-9: Payload Length (uint16, max 65,535 bytes per frame)

export enum MessageType {
  Error = 1,
  Ack = 2,
  Call = 3,
  Response = 4,

  User = 100,

  Reserved = 250,
}

export enum MessageFlags {
  First = 1 << 0,
  Last = 1 << 1,
}

export interface BaseMessage {
  id: number;
  type: MessageType;
  payload: unknown;
}

export interface AckMessage extends BaseMessage {
  type: MessageType.Ack;
  payload: {
    originalId?: number;
  };
}

export interface CallMessage extends BaseMessage {
  type: MessageType.Call;
  payload: {
    requestId: string;
    input?: unknown;
    resumption?: string;
    target?: string;
  };
}

export interface ResponseMessage extends BaseMessage {
  type: MessageType.Response;
  payload: {
    requestId: string;
    output?: unknown;
  };
}

export interface ErrorMessage extends BaseMessage {
  type: MessageType.Error;
  payload: {
    requestId?: string;
    originalId?: number;
    error: {
      name: string;
      message: string;
      stack?: string;
    };
  };
}

export interface UserMessage<
  T extends number = number,
  K extends Record<string, unknown> = Record<string, unknown>,
> extends BaseMessage {
  type: T;
  payload: K & { requestId?: string };
}

export type Message = CallMessage | ErrorMessage | AckMessage | ResponseMessage;

export class MessageReader {
  private _buffer: Uint8Array = new Uint8Array(0);
  private _offset = 0;
  private _length = 0;
  private _pendingMessages = new Map<
    number,
    {
      type: MessageType;
      frames: Uint8Array[];
      totalLength: number;
    }
  >();
  private _messages: Message[] = [];

  /**
   * Push incoming data chunk to the buffer and process complete frames
   * @param chunk - Incoming Uint8Array data
   */
  push(chunk: Uint8Array): void {
    const neededLength = this._length + chunk.length;

    if (this._offset > 0 && this._offset > this._buffer.length / 2) {
      this._compact();
    }

    if (neededLength > this._buffer.length - this._offset) {
      this._grow(neededLength);
    }

    this._buffer.set(chunk, this._offset + this._length);
    this._length += chunk.length;

    this._processBuffer();
  }

  private _compact(): void {
    if (this._offset === 0) return;

    const remaining = this._length;
    if (remaining > 0) {
      this._buffer.copyWithin(0, this._offset, this._offset + remaining);
    }
    this._offset = 0;
  }

  private _grow(minCapacity: number): void {
    const currentCapacity = this._buffer.length - this._offset;

    const newCapacity = Math.max(currentCapacity * 2, minCapacity, 1024);

    const newBuffer = new Uint8Array(newCapacity);
    const remaining = this._length;
    if (remaining > 0) {
      newBuffer.set(
        this._buffer.subarray(this._offset, this._offset + remaining)
      );
    }
    this._buffer = newBuffer;
    this._offset = 0;
  }

  private _processBuffer(): void {
    while (this._length >= 10) {
      const available = this._length;
      const view = this._buffer.subarray(
        this._offset,
        this._offset + available
      );

      const header = this._parseHeader(view);
      const frameSize = 10 + header.payloadLength;

      if (available < frameSize) {
        break;
      }

      const payload = this._buffer.slice(
        this._offset + 10,
        this._offset + frameSize
      );

      this._offset += frameSize;
      this._length -= frameSize;

      this._handleFrame(header, payload);
    }
  }

  /**
   * Parse the 10-byte header (big-endian)
   */
  private _parseHeader(buffer: Uint8Array): {
    version: number;
    typeCode: MessageType;
    payloadLength: number;
    flags: number;
    messageId: number;
    isFirst: boolean;
    isLast: boolean;
  } {
    const version = buffer[0];
    const flags = (buffer[1] << 8) | buffer[2]; // uint16 big-endian
    // uint32 big-endian: bytes 3-6
    const messageId =
      (buffer[3] << 24) | (buffer[4] << 16) | (buffer[5] << 8) | buffer[6];
    const typeCode = buffer[7] as MessageType;
    const payloadLength = (buffer[8] << 8) | buffer[9]; // uint16 big-endian

    const isFirst = (flags & MessageFlags.First) !== 0;
    const isLast = (flags & MessageFlags.Last) !== 0;

    return {
      version,
      typeCode,
      payloadLength,
      flags,
      messageId,
      isFirst,
      isLast,
    };
  }

  private _handleMessage(
    header: ReturnType<typeof this._parseHeader>,
    payload: Uint8Array
  ) {
    if (header.version === 1) {
      this._messages.push({
        id: header.messageId,
        type: header.typeCode,
        payload:
          payload.length > 0
            ? JSON.parse(new TextDecoder().decode(payload))
            : undefined,
      } as Message);
    } else {
      console.error(`Unsupported protocol version: ${header.version}`);
    }
  }

  get hasMessages(): boolean {
    return this._messages.length > 0;
  }

  poll(): Message | undefined {
    return this._messages.shift();
  }

  private _handleFrame(
    header: ReturnType<typeof this._parseHeader>,
    payload: Uint8Array
  ): void {
    if (header.isFirst) {
      if (header.isLast) {
        this._handleMessage(header, payload);
      } else {
        this._pendingMessages.set(header.messageId, {
          type: header.typeCode,
          frames: [payload],
          totalLength: payload.length,
        });
      }
    } else {
      const message = this._pendingMessages.get(header.messageId);
      if (!message) {
        return;
      }

      if (message.type !== header.typeCode) {
        return;
      }

      message.frames.push(payload);
      message.totalLength += payload.length;

      if (header.isLast) {
        const completePayload = new Uint8Array(message.totalLength);
        let offset = 0;
        for (const frame of message.frames) {
          completePayload.set(frame, offset);
          offset += frame.length;
        }

        this._pendingMessages.delete(header.messageId);
        this._handleMessage(header, completePayload);
      }
    }
  }

  reset() {
    this._buffer = new Uint8Array(0);
    this._offset = 0;
    this._length = 0;
    this._pendingMessages.clear();
    this._messages = [];
  }
}

type WritableMessage = Omit<Message, 'id'> & { id?: number };

export class MessageWriter {
  private readonly _maxFramePayloadSize = 65535; // uint16 max

  nextMessageId = 1;
  readonly version = 1;

  /**
   * Write a message to binary frames
   * @param message - The message to write
   * @param messageId - Optional message ID (auto-generated if not provided)
   * @returns Array of Uint8Array frames
   */
  write(message: WritableMessage): Uint8Array[] {
    const id = message.id ?? this.nextMessageId++;
    const payload = this._encodePayload(
      'payload' in message ? message.payload : undefined
    );
    const frames: Uint8Array[] = [];

    if (payload.length <= this._maxFramePayloadSize) {
      const frame = this._createFrame(
        id,
        message.type,
        payload,
        MessageFlags.First | MessageFlags.Last
      );
      frames.push(frame);
    } else {
      let offset = 0;
      let frameIndex = 0;

      while (offset < payload.length) {
        const remaining = payload.length - offset;
        const framePayloadSize = Math.min(remaining, this._maxFramePayloadSize);
        const framePayload = payload.subarray(
          offset,
          offset + framePayloadSize
        );

        const isFirst = frameIndex === 0;
        const isLast = offset + framePayloadSize >= payload.length;

        let flags = 0;
        if (isFirst) flags |= MessageFlags.First;
        if (isLast) flags |= MessageFlags.Last;

        const frame = this._createFrame(id, message.type, framePayload, flags);
        frames.push(frame);

        offset += framePayloadSize;
        frameIndex++;
      }
    }

    return frames;
  }

  /**
   * Write a message and return a single Uint8Array (concatenated frames)
   * Useful for single-frame messages or when you want all frames together
   */
  writeAll(message: WritableMessage): Uint8Array {
    const frames = this.write(message);
    if (frames.length === 1) {
      return frames[0];
    }

    const totalLength = frames.reduce((sum, frame) => sum + frame.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const frame of frames) {
      result.set(frame, offset);
      offset += frame.length;
    }
    return result;
  }

  private _encodePayload(payload: unknown): Uint8Array {
    if (!payload) {
      return new Uint8Array(0);
    }
    const json = JSON.stringify(payload);
    return new TextEncoder().encode(json);
  }

  private _createFrame(
    messageId: number,
    type: MessageType,
    payload: Uint8Array,
    flags: number
  ): Uint8Array {
    const header = new Uint8Array(10);
    const payloadLength = payload.length;

    // Byte 0: Version
    header[0] = this.version;

    // Bytes 1-2: Flags (uint16 big-endian)
    header[1] = (flags >>> 8) & 0xff;
    header[2] = flags & 0xff;

    // Bytes 3-6: Message ID (uint32 big-endian)
    header[3] = (messageId >>> 24) & 0xff;
    header[4] = (messageId >>> 16) & 0xff;
    header[5] = (messageId >>> 8) & 0xff;
    header[6] = messageId & 0xff;

    // Byte 7: Type Code
    header[7] = type;

    // Bytes 8-9: Payload Length (uint16 big-endian)
    header[8] = (payloadLength >>> 8) & 0xff;
    header[9] = payloadLength & 0xff;

    // Combine header and payload
    const frame = new Uint8Array(10 + payloadLength);
    frame.set(header, 0);
    frame.set(payload, 10);

    return frame;
  }

  reset(): void {
    this.nextMessageId = 1;
  }
}
