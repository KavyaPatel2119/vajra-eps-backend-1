import mongoSanitize from 'express-mongo-sanitize';
// These packages ship without TypeScript declarations in this project.
// Use CommonJS require to keep the runtime behavior unchanged.
const xss: any = require('xss-clean');
const hpp: any = require('hpp');

export const securityMiddlewares = [
  mongoSanitize(),
  xss(),
  hpp(),
];
