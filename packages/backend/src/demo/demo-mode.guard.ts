import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { DemoStateService } from './demo-state.service';

/**
 * Hides a route unless demo mode is on right now (the live switch, never on
 * Cloud): the same 404 Nest answers for a route that does not exist, before
 * any authentication, so an instance that is not a demo does not reveal it.
 */
@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(private readonly state: DemoStateService) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.state.isEnabled()) return true;
    const req = context.switchToHttp().getRequest();
    throw new NotFoundException(`Cannot ${req?.method ?? 'GET'} ${req?.originalUrl ?? req?.url ?? ''}`.trim());
  }
}
