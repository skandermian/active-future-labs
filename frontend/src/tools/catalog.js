/**
 * Query tools, after God's Eye View's `src/tools` catalog.
 *
 * Each tool is a named, validated, read-only question over the data that
 * returns `{ summary, data }`: one sentence for people, structured data for
 * programs. The UI calls them today; an assistant (via function calling or
 * MCP) could call the very same tools later, and every number it repeated
 * would come from here rather than from a language model.
 */
export function defineTool({ name, description, run }) {
  if (!/^[a-z_]+$/.test(name)) throw new TypeError(`Bad tool name ${name}`);
  if (typeof run !== 'function') throw new TypeError(`Tool ${name} needs run()`);
  return Object.freeze({ name, description, run });
}

export function composeCatalog(tools, services) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    list: () => tools.map(({ name, description }) => ({ name, description })),
    async call(name, args = {}) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Unknown tool ${name}`);
      return tool.run(args, services);
    },
  };
}
