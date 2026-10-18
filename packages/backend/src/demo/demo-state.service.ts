import { Injectable, Logger } from '@nestjs/common';
import { DeploymentService } from '../common/deployment.service';
import { SiteSettingsService } from '../settings/site-settings.service';
import { demoModeEnvDefault } from './demo.config';

/** Site setting that holds the demo switch: the string `true` or `false`. */
export const DEMO_ENABLED_SETTING = 'demo.enabled';

/**
 * The live demo-mode switch. Persisted in the site settings (`demo.enabled`)
 * and cached in memory: every caller (the guard, the public endpoint, the
 * controls) reads `isEnabled()` synchronously, and only `set()` changes it.
 *
 * DEMO_MODE=true is the INITIAL default only: on a boot where the setting does
 * not exist yet it turns demo mode on and is written to the setting; once the
 * setting exists it wins over the environment. On Cloud demo mode is always
 * off, whatever the setting or the environment say.
 */
@Injectable()
export class DemoStateService {
  private readonly logger = new Logger(DemoStateService.name);
  private enabled = false;

  constructor(
    private readonly settings: SiteSettingsService,
    private readonly deployment: DeploymentService,
  ) {}

  /** Whether the instance may run demo mode at all (self-hosted only). */
  available(): boolean {
    return this.deployment.isSelfHosted();
  }

  /** Demo mode is on right now. Never true on Cloud. */
  isEnabled(): boolean {
    return this.available() && this.enabled;
  }

  /**
   * Reads the persisted switch (once, at boot). An unset setting takes the
   * environment's default, which is stored only when it turns demo mode on, so
   * DEMO_MODE=true on a later boot still works on an instance that never used
   * the switch.
   */
  async load(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (!this.available()) {
      this.enabled = false;
      return false;
    }
    const stored = await this.settings.get(DEMO_ENABLED_SETTING);
    if (stored === 'true' || stored === 'false') {
      this.enabled = stored === 'true';
    } else {
      this.enabled = demoModeEnvDefault(env);
      if (this.enabled) await this.settings.set(DEMO_ENABLED_SETTING, 'true');
    }
    return this.enabled;
  }

  /** Persists the switch, then updates the cache. */
  async set(enabled: boolean): Promise<void> {
    if (!this.available()) throw new Error('Demo mode is not available on Cloud');
    await this.settings.set(DEMO_ENABLED_SETTING, enabled ? 'true' : 'false');
    this.enabled = enabled;
    this.logger.log(`Demo mode ${enabled ? 'on' : 'off'}.`);
  }

  /** In-memory only: demo mode stays off for this boot without touching the setting. */
  suspend(): void {
    this.enabled = false;
  }
}
