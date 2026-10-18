import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const FLOW_WINDOWS = ['1h', '24h', '7d'] as const;
export type FlowWindow = (typeof FLOW_WINDOWS)[number];

/** Most events one `GET /api/flow/events` answers with. */
export const FLOW_EVENTS_MAX = 2000;
/** Longest question the Ask bar sends. */
export const FLOW_ASK_MAX = 500;

/** A window token, or an ISO 8601 date-time with a zone. */
const SINCE_RE =
  /^(?:1h|24h|7d|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))$/;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class FlowQueryDto {
  @ApiPropertyOptional({
    description:
      'MCP server whose data flow to draw. Must belong to your organization. Leave out for every server of the organization.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  serverId?: string;

  @ApiPropertyOptional({
    enum: FLOW_WINDOWS,
    default: '24h',
    description: 'Length of the statistics window, counted back from now.',
  })
  @IsOptional()
  @IsIn(FLOW_WINDOWS)
  since?: FlowWindow;
}

export class FlowEventsQueryDto {
  @ApiPropertyOptional({ description: 'MCP server to replay. Leave out for every server of the organization.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  serverId?: string;

  @ApiPropertyOptional({
    description: 'Start of the window: `1h`, `24h`, `7d` (counted back from `until`) or an ISO 8601 time. At most 7 days before `until`.',
    default: '24h',
  })
  @IsOptional()
  @Matches(SINCE_RE)
  since?: string;

  @ApiPropertyOptional({ description: 'End of the window (ISO 8601). Default: now.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  until?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: FLOW_EVENTS_MAX, default: FLOW_EVENTS_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FLOW_EVENTS_MAX)
  limit?: number;
}

export class FlowAskDto {
  @ApiPropertyOptional({
    description: 'MCP server the question is about. Null or left out: every server of the organization.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  serverId?: string | null;

  @ApiPropertyOptional({ enum: FLOW_WINDOWS, default: '24h' })
  @IsOptional()
  @IsIn(FLOW_WINDOWS)
  window?: FlowWindow;

  @ApiPropertyOptional({ description: 'Id of the selected node (`tool:<id>`, `connector:<id>`, …).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nodeId?: string;

  @ApiProperty({ minLength: 1, maxLength: FLOW_ASK_MAX })
  @Transform(trim)
  @IsString()
  @Length(1, FLOW_ASK_MAX)
  question!: string;
}
