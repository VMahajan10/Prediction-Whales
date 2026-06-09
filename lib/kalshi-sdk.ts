import {
  Configuration,
  GetMarketsStatusEnum,
  MarketApi,
  type Market as KalshiApiMarket,
} from "kalshi-typescript";

export interface KalshiClientOptions {
  keyId: string;
  privateKey: string;
}

export interface ListMarketsOptions {
  limit?: number;
  status?: string;
  series_ticker?: string;
}

function formatPrivateKey(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

const STATUS_MAP: Record<string, GetMarketsStatusEnum> = {
  unopened: GetMarketsStatusEnum.Unopened,
  open: GetMarketsStatusEnum.Open,
  paused: GetMarketsStatusEnum.Paused,
  closed: GetMarketsStatusEnum.Closed,
  settled: GetMarketsStatusEnum.Settled,
};

export class KalshiClient {
  private marketApi: MarketApi;

  constructor({ keyId, privateKey }: KalshiClientOptions) {
    const config = new Configuration({
      apiKey: keyId,
      privateKeyPem: formatPrivateKey(privateKey),
    });
    this.marketApi = new MarketApi(config);
  }

  readonly markets = {
    list: async (
      opts: ListMarketsOptions = {}
    ): Promise<{ markets: KalshiApiMarket[] }> => {
      const status = opts.status ? STATUS_MAP[opts.status] : undefined;
      const response = await this.marketApi.getMarkets(
        opts.limit,
        undefined,
        undefined,
        opts.series_ticker,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        status
      );
      return { markets: response.data.markets ?? [] };
    },
  };
}
