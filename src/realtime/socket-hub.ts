import type { Server as SocketIOServer } from 'socket.io';

let ioInstance: SocketIOServer | null = null;

export function attachSocketHub(io: SocketIOServer): void {
  ioInstance = io;
}

export function getSocketHub(): SocketIOServer | null {
  return ioInstance;
}
