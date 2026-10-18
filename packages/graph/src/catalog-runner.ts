import neo4j from "neo4j-driver";
import type { ManagedTransaction, Record as Neo4jRecord } from "neo4j-driver";
import { performance } from 'node:perf_hooks'
import type { SessionProvider } from './repository';

export interface RunLimits { timeoutMs: number; maxRows: number }
export interface QueryResultSet {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;   // more rows existed than maxRows
  durationMs: number;
}
export const DEFAULT_LIMITS: RunLimits = { timeoutMs: 15000, maxRows: 1000 };

export async function runCatalogQuery(
  sessions: SessionProvider,              // from ./repository
  cypher: string,
  params: Record<string, unknown>,        // already checked; includes $workspace
  limits?: RunLimits,
): Promise<QueryResultSet> {
    const activeLimits = limits ?? DEFAULT_LIMITS;
    const start = performance.now();
    
    const session = await sessions('READ');
    try {
      return await session.executeRead(async (tx: ManagedTransaction) => {
        const result = tx.run(cypher, params);
        const keys = await result.keys();
        
        const collectedRecords: Neo4jRecord[] = [];
        let truncated = false;

        for await (const record of result) {
          if (collectedRecords.length >= activeLimits.maxRows) {
            truncated = true;
            break; // Triggers backpressure halt to stop reading additional incoming records from server
          }
          collectedRecords.push(record);
        }

        return formatResultSet(keys, collectedRecords, start, truncated);
      }, { timeout: activeLimits.timeoutMs }); // Note: standard driver metadata configuration uses 'timeout'
    } finally {
      await session.close();
    }
}

export function formatResultSet(
    keys: string[], 
    records: Neo4jRecord[], // Using the native Neo4j Record type
    startTime: number,
    truncated: boolean
  ): QueryResultSet {
    const durationMs = Math.round(performance.now() - startTime);

    const rows = records.map((record) => {
      const rowObject: Record<string, unknown> = {};
      
      // Correctly iterate over the fields of a Neo4j Record instance
      record.forEach((value, key) => {
        // Deeply unpack custom Neo4j entities down to plain structural serializable JSON objects
        rowObject[String(key)] = convertToPlainJson(value);
      });
      
      return rowObject;
    });

    return {
      columns: keys,
      rows: rows,
      truncated: truncated,
      durationMs: durationMs
    };
}

/**
 * Maps custom graph structures, spatial elements, lossless numbers, or temporal types to standard JSON.
 */
function convertToPlainJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  // Handle Neo4j Lossless Integers
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }

  // Handle Structural Graphs Types: Nodes
  if (value instanceof neo4j.types.Node) {
    return {
      elementId: value.elementId,
      labels: value.labels,
      properties: convertToPlainJson(value.properties)
    };
  }

  // Handle Structural Graphs Types: Relationships
  if (value instanceof neo4j.types.Relationship) {
    
    return {
        
      elementId: value.elementId,
      type: value.type,
      startNodeId: value.startNodeElementId,
      endNodeId: value.endNodeElementId,
      properties: convertToPlainJson(value.properties)
    };
  }

  // Handle Structural Graphs Types: Paths
  if (value instanceof neo4j.types.Path) {
    return {
      start: convertToPlainJson(value.start),
      end: convertToPlainJson(value.end),
      segments: value.segments.map(seg => ({
        start: convertToPlainJson(seg.start),
        relationship: convertToPlainJson(seg.relationship),
        end: convertToPlainJson(seg.end)
      }))
    };
  }

  // Handle Neo4j Temporal Data Types (DateTime, Date, LocalTime, Duration, etc.)
  if (typeof value === 'object' && ('toString' in value) && (
    value instanceof neo4j.types.DateTime || 
    value instanceof neo4j.types.Date || 
    value instanceof neo4j.types.LocalDateTime || 
    value instanceof neo4j.types.LocalTime || 
    value instanceof neo4j.types.Time || 
    value instanceof neo4j.types.Duration
  )) {
    return value.toString();
  }

  // Recurse cleanly into raw Array iterations
  if (Array.isArray(value)) {
    return value.map(convertToPlainJson);
  }

  // Recurse into object properties maps
  if (typeof value === 'object' && value.constructor === Object) {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      output[k] = convertToPlainJson(v);
    }
    return output;
  }

  // Return native serializable scalars (strings, numbers, booleans)
  return value;
}
