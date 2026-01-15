import { Agent } from './agent';
import { Config } from './config';

export class Agents {
  constructor(private _config: Config) {}

  agent(args: { lookupKey: string } | string): Agent {
    const options = typeof args === 'string' ? { lookupKey: args } : args;
    return new Agent(this._config, options);
  }
}
