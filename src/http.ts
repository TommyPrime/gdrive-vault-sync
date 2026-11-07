/**
 * HTTP の差し替え口。本番は main.ts が requestUrl を包んで渡し、テストは偽物を渡す。
 * obsidian を import しないので、auth / drive は Node 上でテストできる。
 */
export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PATCH" | "PUT";
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  text: string;
  arrayBuffer?: ArrayBuffer;
  headers?: Record<string, string>;
}

export type HttpFn = (request: HttpRequest) => Promise<HttpResponse>;
