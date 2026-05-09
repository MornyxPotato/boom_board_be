import express from 'express';
import http from 'http';
import cors from 'cors';
import setupSockets from './presentation/SocketGateway';
import logger from './utils/Logger';

const app = express();
app.use(cors());
const server = http.createServer(app);

// Initialize our socket architecture
setupSockets(server);

const PORT = process.env.PORT || 3000;

// Check if this file is being run directly, or being imported by a test
if (require.main === module) {
  server.listen(PORT, () => {
    logger.info('Boom Board Server is running on port 3000');
  });
}

// Export the server so your testing software can grab it later
export default server;