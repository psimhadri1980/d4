import type { Explainer } from '@d4/cypher';
import type { SessionProvider } from './repository';

/**
 * Asks Neo4j to plan (not run) a query and returns its query type ('r', 'rw', 'w', 's').
 * Uses a READ session, so even a misclassified query cannot write.
 */
export function neo4jExplainer(sessions: SessionProvider): Explainer {
  return {
    async explain(cypher, params) {
      const session = await sessions('READ');
      try {
        const res = await session.run(`EXPLAIN ${cypher}`, params);
        return res.summary.queryType;
      } finally {
        await session.close();
      }
    },
  };
}
