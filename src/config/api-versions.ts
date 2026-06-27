import { v1ToV2RequestTransform, v2ToV1ResponseTransform } from '../schemas/transforms/v1-to-v2';

export interface VersionMetadata {
  version: string;
  status: 'active' | 'deprecated' | 'sunset';
  deprecationDate?: string;
  sunsetDate?: string;
  migrationUrl?: string;
}

export type TransformFunction = (data: any) => any;

export interface VersionConfig {
  metadata: VersionMetadata;
  requestTransforms: TransformFunction[];
  responseTransforms: TransformFunction[];
}

class VersionRegistry {
  private static instance: VersionRegistry;
  private versions: Map<string, VersionConfig> = new Map();
  private defaultVersion: string = 'v2';

  private constructor() {
    this.registerVersions();
  }

  public static getInstance(): VersionRegistry {
    if (!VersionRegistry.instance) {
      VersionRegistry.instance = new VersionRegistry();
    }
    return VersionRegistry.instance;
  }

  private registerVersions() {
    // v1: Deprecated
    this.versions.set('v1', {
      metadata: {
        version: 'v1',
        status: 'deprecated',
        deprecationDate: '2026-10-01T00:00:00Z',
        sunsetDate: '2027-01-01T00:00:00Z',
        migrationUrl: 'https://docs.agritrust.io/api/v2-migration',
      },
      requestTransforms: [v1ToV2RequestTransform],
      responseTransforms: [v2ToV1ResponseTransform],
    });

    // v2: Active (Current)
    this.versions.set('v2', {
      metadata: {
        version: 'v2',
        status: 'active',
      },
      requestTransforms: [],
      responseTransforms: [],
    });
  }

  public getVersionConfig(version: string): VersionConfig | undefined {
    return this.versions.get(version);
  }

  public getAllVersions(): VersionMetadata[] {
    return Array.from(this.versions.values()).map((v) => v.metadata);
  }

  public getDefaultVersion(): string {
    return this.defaultVersion;
  }
}

export const versionRegistry = VersionRegistry.getInstance();
