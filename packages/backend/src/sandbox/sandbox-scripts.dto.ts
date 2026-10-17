import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SANDBOX_TIMEOUT_RANGE_MS } from './limits';

/** Saved-script names: lowercase, start with a letter, 2-64 characters. */
export const SCRIPT_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
export const SCRIPT_NAME_MESSAGE =
  'name must start with a lowercase letter and be 2-64 characters of a-z, 0-9, "_" or "-"';
export const SCRIPT_CODE_MAX_CHARS = 64 * 1024;
export const SCRIPT_DESCRIPTION_MAX_CHARS = 2_000;
/** A script may use up to this many connectors, and this many tools across them. */
export const SCRIPT_MAX_CONNECTORS = 20;
export const SCRIPT_MAX_TOOLS = 100;

/** The tools of one connector that a script uses, as picked by a person. */
export class ScriptUseDto {
  @ApiProperty({ description: 'Id of a connector of this organization.' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  connectorId!: string;

  @ApiProperty({
    type: [String],
    description: 'Names of the tools of that connector the script calls. At least one.',
  })
  @IsArray()
  @ArrayMaxSize(SCRIPT_MAX_TOOLS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  tools!: string[];
}

export class CreateSandboxScriptDto {
  @ApiProperty({ example: 'delayed_orders_last_month' })
  @IsString()
  @Matches(SCRIPT_NAME_PATTERN, { message: SCRIPT_NAME_MESSAGE })
  name!: string;

  @ApiProperty({ description: 'JavaScript body; top-level await and return are allowed.' })
  @IsString()
  @MinLength(1)
  @MaxLength(SCRIPT_CODE_MAX_CHARS)
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(SCRIPT_DESCRIPTION_MAX_CHARS)
  description?: string;

  @ApiPropertyOptional({
    type: [ScriptUseDto],
    description:
      'The connectors and tools the script uses. Tools found in the code are added to this list; ' +
      'a saved script can call only the tools it declares.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCRIPT_MAX_CONNECTORS)
  @ValidateNested({ each: true })
  @Type(() => ScriptUseDto)
  uses?: ScriptUseDto[];
}

export class UpdateSandboxScriptDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(SCRIPT_CODE_MAX_CHARS)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(SCRIPT_DESCRIPTION_MAX_CHARS)
  description?: string;

  @ApiPropertyOptional({
    type: [ScriptUseDto],
    description:
      'The connectors and tools the script uses. Tools found in the code are added to this list; ' +
      'a saved script can call only the tools it declares.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCRIPT_MAX_CONNECTORS)
  @ValidateNested({ each: true })
  @Type(() => ScriptUseDto)
  uses?: ScriptUseDto[];
}

/** Exactly one of `code` / `scriptId` is required; the controller checks. */
export class RunSandboxDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(SCRIPT_CODE_MAX_CHARS)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  scriptId?: string;

  @ApiPropertyOptional({ description: 'Exposed to the script as `args`.' })
  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;

  @ApiPropertyOptional({
    minimum: SANDBOX_TIMEOUT_RANGE_MS.min,
    maximum: SANDBOX_TIMEOUT_RANGE_MS.max,
  })
  @IsOptional()
  @IsInt()
  @Min(SANDBOX_TIMEOUT_RANGE_MS.min)
  @Max(SANDBOX_TIMEOUT_RANGE_MS.max)
  timeoutMs?: number;
}

export class ListSandboxScriptsQueryDto {
  @ApiPropertyOptional({ description: 'Set to 1 to include each script\'s code.', enum: ['1', 'true', '0', 'false'] })
  @IsOptional()
  @IsIn(['1', 'true', '0', 'false'])
  includeCode?: string;
}

export class ListSandboxRunsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class BenchmarkDto {
  @ApiProperty({ description: 'Connector tool to call directly (the raw path).' })
  @IsString()
  toolName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  toolArgs?: Record<string, unknown>;

  @ApiProperty({ description: 'Script that answers the same question inside the sandbox.' })
  @IsString()
  @MinLength(1)
  @MaxLength(SCRIPT_CODE_MAX_CHARS)
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}
