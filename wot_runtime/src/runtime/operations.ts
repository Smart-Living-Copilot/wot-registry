import log from '../logger/index.js';
import { annotateThingDescriptionSecurityNames } from '../runtime/credentials.js';
import { getWotClient } from '../runtime/servient.js';
import { config } from '../config/env.js';
import { buildCacheKey, getCached, setCached } from '../services/cache.js';
import { type ContentStoreEntry, fetchContentBlob, storeContentBlob } from '../services/content-store-client.js';
import { fetchThingDescription, type ThingDescription } from '../services/thing-catalog-client.js';
import {
  decodePayloadEnvelope,
  encodeInteractionOutputPayload,
  encodePayloadEnvelope,
  normalizeBody,
} from '../services/payloads.js';
import { createRuntimeError, formatError } from '../services/errors.js';
import { getAffordanceDefinition, resolveFormIndex } from '../services/form-selection.js';
import { getRuntimeHealth } from '../services/runtime-health.js';

/**
 * Supported interaction operations for metrics and logging.
 */
type InteractionOperation = 'read_property' | 'invoke_action';

/**
 * Internal representation of an interaction payload after encoding.
 */
type EncodedInteractionPayload = {
  body: Buffer;
  contentType: string;
  sourceProtocol: string;
};

/**
 * Media type used for payloads that reference external content (offloaded).
 */
const CONTENT_REF_MEDIA_TYPE = 'application/vnd.wot.content-ref+json';

/**
 * Checks if a payload is a content reference (referencing an offloaded blob).
 */
function isContentRefPayload(payload: any): boolean {
  if (!payload) return false;
  const ct = String(payload.contentType || '')
    .trim()
    .toLowerCase();
  return ct === CONTENT_REF_MEDIA_TYPE;
}

/**
 * Resolves a content reference input by fetching the actual blob from the content store.
 * Used when an action input or property write is too large to be sent inline.
 *
 * @param payload The content reference payload.
 * @returns The resolved payload { body: Buffer, contentType: string }.
 * @throws {RuntimeError} if the content reference is empty or invalid.
 */
async function resolveContentRefInput(payload: any): Promise<any> {
  const body = normalizeBody(payload.body);
  if (body.length === 0) return payload;

  let contentRef: string;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    contentRef = typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    contentRef = body.toString('utf8').trim();
  }

  if (!contentRef) {
    throw createRuntimeError('invalid_argument', 'Content reference is empty');
  }

  log.info(`Resolving content ref '${contentRef}' for action input`);
  const resolved = await fetchContentBlob(contentRef);
  return {
    body: resolved.payload,
    contentType: resolved.contentType,
  };
}

/**
 * Checks if a value is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts the thingId from a runtime request.
 */
function getRequestedThingId(request: any): string {
  return String(request?.target?.thingId || request?.thingId || '').trim();
}

/**
 * Decodes URI variables from a runtime request.
 */
function decodeUriVariables(uriVariables: any[] | undefined): Record<string, unknown> {
  const entries = Array.isArray(uriVariables) ? uriVariables : [];
  const values: Record<string, unknown> = {};

  for (const entry of entries) {
    const name = String(entry?.name || '').trim();
    if (!name) {
      continue;
    }
    values[name] = decodePayloadEnvelope(entry.value);
  }

  return values;
}

/**
 * Builds interaction options (uriVariables, formIndex) for node-wot.
 */
function buildInteractionOptions(request: any, resolvedFormIndex?: number): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  const uriVariables = decodeUriVariables(request.uriVariables);

  if (Object.keys(uriVariables).length > 0) {
    options.uriVariables = uriVariables;
  }

  const formIndex = resolvedFormIndex ?? request?.formSelector?.formIndex;
  if (typeof formIndex === 'number' && Number.isInteger(formIndex)) {
    options.formIndex = formIndex;
  }

  return Object.keys(options).length === 0 ? undefined : options;
}

/**
 * Builds a standardized interaction response object from an encoded payload.
 */
function buildEncodedInteractionResponse(
  payload: { body: Buffer; contentType: string },
  responseContentType?: string,
): { response: any } {
  const normalizedResponseContentType = responseContentType || payload.contentType || 'application/json';

  return {
    response: {
      payload: {
        body: payload.body,
        contentType: payload.contentType,
      },
      responseContentType: normalizedResponseContentType,
      matchedAdditionalResponse: false,
      success: true,
      statusCode: 200,
      statusText: 'ok',
      chosenForm: {},
    },
  };
}

/**
 * Builds a standardized interaction response object from a high-level value.
 */
function buildInteractionResponse(value: unknown, contentType?: string): { response: any } {
  const payload = encodePayloadEnvelope(value, contentType);
  return buildEncodedInteractionResponse(
    {
      body: normalizeBody(payload.body),
      contentType: String(payload.contentType || contentType || 'application/json'),
    },
    contentType || String(payload.contentType || 'application/json'),
  );
}

/**
 * Wraps a ContentStoreEntry into a content reference handle.
 */
function buildContentRefHandle(entry: ContentStoreEntry): {
  body: Buffer;
  contentType: string;
} {
  const payload = encodePayloadEnvelope(
    {
      kind: 'content_ref',
      content_ref: entry.content_ref,
      content_type: entry.content_type,
      size_bytes: entry.size_bytes,
      digest: entry.digest,
      filename: entry.filename,
      created_at: entry.created_at,
      expires_at: entry.expires_at,
      ttl_seconds: entry.ttl_seconds,
      source: entry.source,
      metadata: entry.metadata,
      preview: entry.preview,
      detail_url: entry.detail_url,
      download_url: entry.download_url,
    },
    CONTENT_REF_MEDIA_TYPE,
  );

  return {
    body: normalizeBody(payload.body),
    contentType: CONTENT_REF_MEDIA_TYPE,
  };
}

/**
 * Builds an interaction response, automatically offloading the payload to the content store
 * if it exceeds the configured maximum inline size.
 *
 * @param payload The encoded interaction payload.
 * @param context Metadata about the interaction for tracking and cleanup.
 * @returns A standardized interaction response, potentially containing a content reference.
 */
async function buildOffloadAwareInteractionResponse(
  payload: EncodedInteractionPayload,
  context: {
    thingId: string;
    affordanceName: string;
    operation: InteractionOperation;
    tdHash: string;
  },
): Promise<{ response: any }> {
  if (payload.body.length <= config.inlinePayloadMaxBytes) {
    return buildEncodedInteractionResponse(
      {
        body: payload.body,
        contentType: payload.contentType,
      },
      payload.contentType,
    );
  }

  const metadata: Record<string, unknown> = {
    thing_id: context.thingId,
    affordance_name: context.affordanceName,
    operation: context.operation,
    thing_description_hash: context.tdHash,
    original_content_type: payload.contentType,
    inline_threshold_bytes: config.inlinePayloadMaxBytes,
  };

  if (payload.sourceProtocol) {
    metadata.source_protocol = payload.sourceProtocol;
  }

  try {
    const entry = await storeContentBlob({
      payload: payload.body,
      contentType: payload.contentType,
      ttlSeconds: config.offloadedPayloadTtlSeconds > 0 ? config.offloadedPayloadTtlSeconds : undefined,
      source: `wot_runtime.${context.operation}`,
      metadata,
    });

    return buildEncodedInteractionResponse(buildContentRefHandle(entry), CONTENT_REF_MEDIA_TYPE);
  } catch (error) {
    log.warn(
      `Failed to offload oversized ${context.operation} output for '${context.thingId}/${context.affordanceName}', returning inline payload: ${formatError(error)}`,
    );
    return buildEncodedInteractionResponse(
      {
        body: payload.body,
        contentType: payload.contentType,
      },
      payload.contentType,
    );
  }
}

/**
 * Fetches a Thing Description and consumes it via the node-wot servient.
 */
async function consumeThing(request: any): Promise<{
  thing: any;
  document: ThingDescription;
  hash: string;
}> {
  const thingId = getRequestedThingId(request);
  if (!thingId) {
    throw createRuntimeError('invalid_argument', 'thing_id is required');
  }

  const { document, hash } = await fetchThingDescription(thingId).catch((error) => {
    throw createRuntimeError('not_found', formatError(error));
  });

  annotateThingDescriptionSecurityNames(document);
  const wot = await getWotClient();
  const thing = await wot.consume(document);

  return { thing, document, hash };
}

/**
 * Handles a request to retrieve a Thing Description.
 *
 * @param request The runtime request containing the thingId.
 */
export async function handleGetThingDescription(request: any): Promise<any> {
  const thingId = String(request?.thingId || '').trim();
  if (!thingId) {
    throw createRuntimeError('invalid_argument', 'thing_id is required');
  }

  const { document, hash } = await fetchThingDescription(thingId).catch((error) => {
    throw createRuntimeError('not_found', formatError(error));
  });

  return {
    thingId,
    thingDescription: encodePayloadEnvelope(document, 'application/td+json'),
    tdHash: hash,
  };
}

/**
 * Handles a ReadProperty interaction.
 *
 * @param request The runtime request containing target and options.
 */
export async function handleReadProperty(request: any): Promise<any> {
  const thingId = getRequestedThingId(request);
  const propertyName = String(request?.target?.affordanceName || '').trim();
  if (!propertyName) {
    throw createRuntimeError('invalid_argument', 'target.affordance_name is required for ReadProperty');
  }

  const { thing, document, hash } = await consumeThing(request);
  if (!getAffordanceDefinition(document, propertyName, 'readproperty')) {
    throw createRuntimeError('not_found', `Thing '${thingId}' does not define property '${propertyName}'`);
  }

  const resolvedFormIndex = (() => {
    try {
      return resolveFormIndex(document, propertyName, 'readproperty', request?.formSelector);
    } catch (error) {
      throw createRuntimeError('invalid_argument', formatError(error));
    }
  })();

  const options = buildInteractionOptions(request, resolvedFormIndex);
  const result = await thing.readProperty(propertyName, options);

  const payload = await encodeInteractionOutputPayload(result, {
    onInvalidSchema: () => {
      log.warn(`Property '${propertyName}' returned data that failed schema validation, returning raw value`);
    },
  });

  return buildOffloadAwareInteractionResponse(payload, {
    thingId,
    affordanceName: propertyName,
    operation: 'read_property',
    tdHash: hash,
  });
}

/**
 * Handles a WriteProperty interaction.
 *
 * @param request The runtime request containing target, input, and options.
 */
export async function handleWriteProperty(request: any): Promise<any> {
  const thingId = getRequestedThingId(request);
  const propertyName = String(request?.target?.affordanceName || '').trim();
  if (!propertyName) {
    throw createRuntimeError('invalid_argument', 'target.affordance_name is required for WriteProperty');
  }

  const resolvedWriteInput = isContentRefPayload(request.input)
    ? await resolveContentRefInput(request.input)
    : request.input;
  const input = decodePayloadEnvelope(resolvedWriteInput);
  if (input === undefined) {
    throw createRuntimeError('invalid_argument', 'input payload is required for WriteProperty');
  }

  const { thing, document } = await consumeThing(request);
  if (!getAffordanceDefinition(document, propertyName, 'writeproperty')) {
    throw createRuntimeError('not_found', `Thing '${thingId}' does not define property '${propertyName}'`);
  }

  const resolvedFormIndex = (() => {
    try {
      return resolveFormIndex(document, propertyName, 'writeproperty', request?.formSelector);
    } catch (error) {
      throw createRuntimeError('invalid_argument', formatError(error));
    }
  })();

  const options = buildInteractionOptions(request, resolvedFormIndex);
  await thing.writeProperty(propertyName, input, options);

  return buildInteractionResponse(undefined);
}

/**
 * Handles an InvokeAction interaction.
 *
 * @param request The runtime request containing target, input, and options.
 */
export async function handleInvokeAction(request: any): Promise<any> {
  const thingId = getRequestedThingId(request);
  const actionName = String(request?.target?.affordanceName || '').trim();
  if (!actionName) {
    throw createRuntimeError('invalid_argument', 'target.affordance_name is required for InvokeAction');
  }

  const { thing, document, hash } = await consumeThing(request);
  if (!getAffordanceDefinition(document, actionName, 'invokeaction')) {
    throw createRuntimeError('not_found', `Thing '${thingId}' does not define action '${actionName}'`);
  }

  const resolvedFormIndex = (() => {
    try {
      return resolveFormIndex(document, actionName, 'invokeaction', request?.formSelector);
    } catch (error) {
      throw createRuntimeError('invalid_argument', formatError(error));
    }
  })();

  const options = buildInteractionOptions(request, resolvedFormIndex) || {};
  const resolvedInput = isContentRefPayload(request.input)
    ? await resolveContentRefInput(request.input)
    : request.input;
  const input = decodePayloadEnvelope(resolvedInput);
  const actionDef = getAffordanceDefinition(document, actionName, 'invokeaction');

  if (isPlainObject(actionDef) && actionDef.synchronous === false) {
    throw createRuntimeError(
      'unimplemented',
      `Action '${actionName}' declares synchronous=false and query/cancel support is not implemented yet`,
    );
  }

  const isCacheable = isPlainObject(actionDef) && actionDef.safe === true;
  const uriVariables = decodeUriVariables(request.uriVariables);
  const cacheKey = isCacheable ? buildCacheKey(thingId, 'invoke_action', actionName, uriVariables, input) : '';

  if (isCacheable) {
    const cached = await getCached(cacheKey);
    if (cached) {
      log.info(`Cache hit for invokeAction '${thingId}/${actionName}'`);
      return {
        completedResult: buildEncodedInteractionResponse(
          { body: Buffer.from(cached.payload, 'base64'), contentType: cached.contentType },
          cached.contentType,
        ).response,
      };
    }
  }

  const result =
    input === undefined
      ? await thing.invokeAction(actionName, undefined, options)
      : await thing.invokeAction(actionName, input, options);

  if (result) {
    const payload = await encodeInteractionOutputPayload(result, {
      onInvalidSchema: () => {
        log.warn(`Action '${actionName}' returned data that failed output schema validation, returning raw value`);
      },
    });
    const interactionResponse = await buildOffloadAwareInteractionResponse(payload, {
      thingId,
      affordanceName: actionName,
      operation: 'invoke_action',
      tdHash: hash,
    });

    if (isCacheable) {
      await setCached(
        cacheKey,
        { contentType: payload.contentType, payload: payload.body.toString('base64'), statusCode: 200 },
        payload.body.length,
      ).catch((error) => log.warn(`Cache write failed for invokeAction '${thingId}/${actionName}': ${formatError(error)}`));
    }

    return { completedResult: interactionResponse.response };
  }

  return {
    completedResult: buildInteractionResponse(undefined).response,
  };
}

/**
 * Handles a health check request, returning the status of various runtime components.
 */
export async function handleGetRuntimeHealth(): Promise<any> {
  const health = await getRuntimeHealth();

  return {
    status: health.status,
    servientReady: health.servientReady,
    backendReachable: health.backendReachable,
    valkeyConfigured: health.valkeyConfigured,
    protocols: health.protocols,
    startedAt: health.startedAt || '',
  };
}
