export type PushPlatform = "ios" | "android";

export interface DeviceTokenRecord {
  token: string;
  platform: PushPlatform;
  createdAt: Date;
  updatedAt: Date;
}

export interface PushMessagePayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushSendResult {
  sent: number;
  failed: number;
  skipped: number;
}
