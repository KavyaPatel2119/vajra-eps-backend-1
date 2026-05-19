import { Express } from 'express';
import { Server as HTTPServer } from 'http';
import { WebSocketGateway } from './websocket.gateway';

export function setupWebSocket(app: Express, httpServer: HTTPServer) {
  const gateway = new WebSocketGateway(httpServer);

  // Store gateway in app for later access
  (app as any).wsGateway = gateway;

  return gateway;
}
