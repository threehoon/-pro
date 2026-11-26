import 'fastify';
import type { SessionUser } from './auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}