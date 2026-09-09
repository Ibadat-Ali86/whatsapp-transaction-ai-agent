const pino = require('pino');
const config = require('./config');

const isDev = process.env.NODE_ENV !== 'production';

const transport = isDev ? {
  target: 'pino-pretty',
  options: { colorize: true }
} : undefined;

const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'whatsapp-bot', version: '1.0.0' },
  transport
});

module.exports = {
  logger,
  createChild: (bindings) => logger.child(bindings)
};
