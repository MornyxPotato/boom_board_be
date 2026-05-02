import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import registerRoomHandlers from './RoomGateway';
import registerGameHandlers from './GameGateway';
import GameService from '../application/GameService';
import logger from '../utils/Logger';

export default (server: HttpServer) => {
    // Initialize Socket.IO with our HTTP server
    const io = new SocketIOServer(server, { cors: { origin: "*" } });

    io.on('connection', (socket: Socket) => {
        logger.debug(`Player connected: ${socket.id}`);

        // Pass the typed io and socket instances to our handlers
        registerRoomHandlers(io, socket);
        registerGameHandlers(io, socket);
    });

    GameService.init(io);
};