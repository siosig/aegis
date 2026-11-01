export { createAegisServer } from './server.js';
export {
  AegisService,
  isOperationAllowedOnSurface,
  isSurface,
  SSA_ALLOWED_OPERATIONS,
  SURFACES,
  type Surface,
  type SurfaceGatedOperation,
  SurfaceViolationError,
} from './services.js';
