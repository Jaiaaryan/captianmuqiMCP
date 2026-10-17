/**
 * The processor registry over HTTP: what a response processor chain can be
 * built from, and whether a given chain is valid.
 *
 * Separate from the tool endpoints on purpose — the registry belongs to the
 * installation, not to one connector's tool, and both the dashboard's chain
 * editor and an agent writing a chain need to read it before they can write
 * one. Nothing here touches a tool or a connector, so it needs no more than a
 * signed-in user.
 */
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';
import {
  PROCESSOR_CHAIN_LIMITS,
  readProcessorChain,
  runProcessorChain,
  validateProcessorChain,
} from './processor-chain.util';
import { describeProcessors } from './processor-registry';

class ProcessorChainDto {
  @ApiPropertyOptional({
    description: 'The chain to check or run: `{ steps: [...] }`.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  processors?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'The response to run the chain against (dry run only).' })
  @IsOptional()
  sample?: unknown;
}

function byteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    return 0;
  }
}

@ApiTags('Response processors')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/processors')
export class ProcessorsController {
  @Get()
  @ApiOperation({
    summary: 'List the processors a response processor chain can use',
    description:
      'Every processor with its version, what it reads, what it writes and ' +
      'its parameters. A chain step names one of these (`number_scale@1`), ' +
      'the collection it runs over (`each`), the field it reads (`reads`), ' +
      'the field it writes (`writes`) and how it may write (`mode`: add, ' +
      'replace, upsert). Processors are pure: a processor cannot read another ' +
      'field, call a tool, or reach the network or the file system.',
  })
  list() {
    return {
      processors: describeProcessors(),
      writeModes: [
        { mode: 'add', description: 'The target field must not exist yet.' },
        { mode: 'replace', description: 'The target field must already exist.' },
        { mode: 'upsert', description: 'Either. The default.' },
      ],
      limits: PROCESSOR_CHAIN_LIMITS,
    };
  }

  @Post('validate')
  @ApiOperation({
    summary: 'Check a processor chain against the registry',
    description:
      'The same check that runs before a chain can be stored on a tool: ' +
      'unknown processor, wrong or missing parameter, bad path, duplicate step ' +
      'id. Returns the first problem, so a chain can be checked while it is ' +
      'being written.',
  })
  validate(@Body() dto: ProcessorChainDto) {
    const error = validateProcessorChain(dto.processors);
    return { valid: !error, ...(error ? { error } : {}) };
  }

  @Post('dry-run')
  @ApiOperation({
    summary: 'Run a processor chain against a sample response',
    description:
      'Runs the chain over a response supplied in the request and returns the ' +
      'result and what each step touched. No tool and no connector is ' +
      'involved, so a chain can be worked out from a pasted response before a ' +
      'tool is picked. On a refused value the untouched sample comes back with ' +
      'the error, the step and the JSON path.',
  })
  dryRun(@Body() dto: ProcessorChainDto) {
    const error = validateProcessorChain(dto.processors);
    if (error) return { ok: false, error };

    const chain = readProcessorChain(
      dto.processors ? { processors: dto.processors } : null,
    );
    if (!chain) {
      return { ok: true, chainActive: false, steps: [], result: dto.sample ?? null };
    }

    const run = runProcessorChain(dto.sample, chain, { trace: true });
    return {
      ok: run.ok,
      chainActive: true,
      steps: run.steps,
      result: run.value,
      rawBytes: byteLength(dto.sample),
      resultBytes: byteLength(run.value),
      ...(run.ok
        ? {}
        : { error: run.error, failedStep: run.failedStep, failedPath: run.failedPath }),
    };
  }
}
