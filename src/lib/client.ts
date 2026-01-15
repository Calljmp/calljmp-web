import { Agents } from './agents';
import { Config } from './config';

export class Calljmp {
  public readonly agents: Agents;

  constructor(config: { projectId: string } & Partial<Config>) {
    const baseUrl =
      (config.development?.enabled && config.development?.baseUrl) ||
      'https://api.calljmp.com';

    const finalConfig: Config = {
      baseUrl,
      serviceUrl: `${baseUrl}/target/v1`,
      ...config,
    };
    this.agents = new Agents(finalConfig);
  }
}
