export interface Config {
  projectId: string;

  baseUrl: string;
  serviceUrl: string;

  development?: {
    enabled: boolean;
    baseUrl?: string;
  };
}
