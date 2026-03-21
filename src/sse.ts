import type { Response } from "express";

export function registerSseClient(res: Response, clientSet: Set<Response>): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  clientSet.add(res);
  res.on("close", () => {
    clientSet.delete(res);
  });
}

export function broadcastSse(clientSet: Set<Response>, data: string): void {
  for (const client of clientSet) {
    try {
      client.write(data);
    } catch {
      clientSet.delete(client);
    }
  }
}
