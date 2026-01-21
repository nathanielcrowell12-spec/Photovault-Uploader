import * as winston from 'winston'
import * as path from 'path'
import { app } from 'electron'

// Get logs directory - Electron provides platform-specific paths
// Windows: C:\Users\{username}\AppData\Local\{appName}\logs
// macOS: ~/Library/Logs/{appName}
// Linux: ~/.config/{appName}/logs
const logsDir = app.getPath('logs')

// Create logger with structured format
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'photovault-desktop' },
  transports: [
    // Write all logs to combined.log
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
    }),
    // Write errors to separate file
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
    }),
  ],
})

// Also log to console in development (with colored output)
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ level, message, timestamp, ...meta }) => {
        const metaStr = Object.keys(meta).length > 1
          ? ` ${JSON.stringify(meta)}`
          : ''
        return `${timestamp} ${level}: ${message}${metaStr}`
      })
    ),
  }))
}

export default logger
