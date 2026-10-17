import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { describeBuiltins } from './builtins';
import { CHAIN_LIMITS } from './chain';
import { DryRunDto, PreviewDto, ValidateChainDto } from './response-processing.dto';
import { ResponseProcessingService, truncateSample } from './response-processing.service';
import { SCRIPT_LIMITS } from './script-runner';

/** What the JWT strategy leaves on the request: the active membership's role. */
interface ProcessingRequest {
  user: { sub: string; role: string; organizationId: string };
}

/**
 * Editor API for response processing. Saving a chain is not a route here: the
 * editor writes `responseMapping.responseProcessing` through the tool update
 * route, like every other part of the mapping.
 */
@ApiTags('Response processing')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/response-processing')
export class ResponseProcessingController {
  constructor(private readonly service: ResponseProcessingService) {}

  /** Running scripts costs CPU, so viewers (read-only) are kept out of it. */
  private assertCanEdit(req: ProcessingRequest) {
    if (req.user.role === 'VIEWER') {
      throw new ForbiddenException('Viewers cannot edit response processing');
    }
  }

  @Get('builtins')
  @ApiOperation({ summary: 'List the built-in processors, step modes and limits' })
  builtins() {
    return {
      builtins: describeBuiltins(),
      modes: ['add', 'replace', 'upsert'],
      limits: {
        maxSteps: CHAIN_LIMITS.maxSteps,
        script: {
          timeoutMs: SCRIPT_LIMITS.timeoutMs,
          memoryMb: SCRIPT_LIMITS.memoryMb,
          maxCodeBytes: SCRIPT_LIMITS.maxCodeBytes,
          maxResultBytes: SCRIPT_LIMITS.maxResultBytes,
        },
      },
    };
  }

  @Post('validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check a chain without running it' })
  validate(@Req() req: ProcessingRequest, @Body() dto: ValidateChainDto) {
    this.assertCanEdit(req);
    return this.service.validate(dto.chain);
  }

  @Post('dry-run')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run a chain over a sample response',
    description: 'Always traced. Nothing is stored and no upstream call is made.',
  })
  dryRun(@Req() req: ProcessingRequest, @Body() dto: DryRunDto) {
    this.assertCanEdit(req);
    return this.service.dryRun(dto.chain, dto.sample);
  }

  @Get('tools/:toolId')
  @ApiOperation({
    summary: "A tool's stored chain and its most recent recorded response",
    description:
      'The sample is cut for the editor: arrays to 3 elements, depth 8, 64 KB; `sampleTruncated` says whether anything was cut.',
  })
  async getForTool(@Req() req: ProcessingRequest, @Param('toolId') toolId: string) {
    const tool = await this.service.getToolForOrganization(
      toolId,
      req.user.organizationId,
    );
    const recorded = await this.service.findLatestSample(toolId);
    if (!recorded) return { chain: this.service.storedChain(tool), sampleAvailable: false };
    const { sample, truncated } = truncateSample(recorded.output);
    return {
      chain: this.service.storedChain(tool),
      sampleAvailable: true,
      sampleCapturedAt: recorded.createdAt.toISOString(),
      sample,
      sampleTruncated: truncated,
    };
  }

  @Post('tools/:toolId/preview')
  @HttpCode(200)
  @ApiOperation({
    summary: "Run a chain over a sample, defaulting to the tool's stored chain",
    description:
      'With no `sample`, the most recent response recorded for the tool is used.',
  })
  async preview(
    @Req() req: ProcessingRequest,
    @Param('toolId') toolId: string,
    @Body() dto: PreviewDto,
  ) {
    this.assertCanEdit(req);
    const tool = await this.service.getToolForOrganization(
      toolId,
      req.user.organizationId,
    );

    const chain = dto.chain ?? this.service.storedChain(tool);
    if (!chain) return { ok: false, error: 'no chain', steps: [] };

    let sample = dto.sample;
    let sampleSource: 'request' | 'recorded' = 'request';
    let sampleCapturedAt: string | undefined;
    if (sample === undefined) {
      const recorded = await this.service.findLatestSample(toolId);
      if (!recorded) return { ok: false, error: 'no sample', steps: [] };
      sample = recorded.output;
      sampleSource = 'recorded';
      sampleCapturedAt = recorded.createdAt.toISOString();
    }

    return {
      ...this.service.dryRun(chain, sample),
      sampleSource,
      ...(sampleCapturedAt ? { sampleCapturedAt } : {}),
    };
  }
}
