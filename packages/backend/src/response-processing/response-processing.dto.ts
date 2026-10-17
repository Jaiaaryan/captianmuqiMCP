import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsObject, IsOptional } from 'class-validator';

/**
 * Bodies carry the chain as a plain object. Its inside is checked by
 * `validateChain` (chain.ts), which names the offending step; class-validator
 * only guarantees the envelope, so a bad body is a 400 and a bad chain is a
 * `{ valid: false, problem }` the editor can show next to the step.
 */

export class ValidateChainDto {
  @ApiProperty({
    description: 'The response processing chain to check.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  chain: Record<string, unknown>;
}

export class DryRunDto {
  @ApiProperty({
    description: 'The response processing chain to run.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  chain: Record<string, unknown>;

  @ApiProperty({
    description: 'The sample response to run it over (any JSON value).',
  })
  @IsDefined()
  sample: unknown;
}

export class PreviewDto {
  @ApiPropertyOptional({
    description: 'The chain to run. Defaults to the one stored on the tool.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  chain?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Sample response. Defaults to the most recent response recorded for the tool.',
  })
  @IsOptional()
  sample?: unknown;
}
