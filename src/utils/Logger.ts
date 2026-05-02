import pino from 'pino';

// If we are not in production, use pino-pretty to make it look nice in the terminal
const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: isDev ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
        }
    } : undefined // In production, it just spits out raw, hyper-fast JSON
});

export default logger;