import type { Server as TcpServer } from "node:net";
import type { Server as HttpServer } from "node:http";

export type FaultReceipt = {
  receipt_id: string;
  phase: "intent" | "accept" | "finish";
  session_id: string;
  run_id: string;
  query_hash: string;
  command_tag: string;
  delivery: string;
};
export type ProxyStatus = {
  held: FaultReceipt | null;
  records: FaultReceipt[];
  errors: string[];
  connections: number;
};
export function startProxy(options?: {
  upstreamHost?: string;
  upstreamPort?: number;
  host?: string;
  dbPort?: number;
  httpPort?: number;
  holdMs?: number;
}): Promise<{ tcp: TcpServer; http: HttpServer; close(): Promise<void> }>;
