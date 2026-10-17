import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const FLOW_WINDOWS = ['1h', '24h', '7d'] as const;
export type FlowWindow = (typeof FLOW_WINDOWS)[number];

export class FlowQueryDto {
  @ApiProperty({ description: 'MCP server whose data flow to draw. Must belong to your organization.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  serverId!: string;

  @ApiPropertyOptional({
    enum: FLOW_WINDOWS,
    default: '24h',
    description: 'Length of the statistics window, counted back from now.',
  })
  @IsOptional()
  @IsIn(FLOW_WINDOWS)
  since?: FlowWindow;
}
