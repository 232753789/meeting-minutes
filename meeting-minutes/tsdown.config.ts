import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const clientId = '@deepseek-ai/dsh-meeting-minutes'

/**
 * Specifiers the host's client module table answers (the platform seed of
 * `@deepseek-ai/dsh-client-web`). They must stay `require()` calls: a second
 * React copy inlined here breaks every hook with "Invalid hook call", and a
 * second store or slots copy loses the host's runtime identity. Everything
 * else is inlined, because a `require()` the table cannot answer throws.
 */
const PLATFORM_MODULES: ReadonlySet<string> = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/**
 * Virtual-id wrapper for `*.module.css`. The `.mjs` suffix keeps the id away
 * from tsdown's own CSS pipeline, which would extract a `style.css` the host
 * never loads.
 */
const CSS_MODULE_PREFIX = '\0dsh-css:'
const CSS_MODULE_SUFFIX = '.mjs'

/**
 * Compile each CSS Module with lightningcss and emit a module that injects the
 * sheet as a `<style data-plugin>` tag when the factory runs, then exports the
 * hashed class map. The client module loader claims tags carrying this
 * plugin's id and removes them when the plugin is unloaded.
 */
function cssModulesInline(id: string) {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const file = importer === undefined || isAbsolute(source) ? source : resolve(dirname(importer), source)
      return CSS_MODULE_PREFIX + file + CSS_MODULE_SUFFIX
    },
    async load(this: { addWatchFile: (file: string) => void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_MODULE_PREFIX)) return null
      const file = virtualId.slice(CSS_MODULE_PREFIX.length, -CSS_MODULE_SUFFIX.length)
      this.addWatchFile(file)
      const { code, exports } = transform({
        filename: file,
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = Object.fromEntries(
        Object.entries(exports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([local, entry]) => [local, entry.name]),
      )
      const tagId = `${id}/${basename(file)}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(id)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/**
 * Reject value imports of other `@deepseek-ai` packages the module table does
 * not answer: inlining one duplicates its runtime instance, and leaving it
 * external throws at `require()`. Type-only imports are erased before this.
 */
function clientBundlePurity(id: string) {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/') || PLATFORM_MODULES.has(source)) return null
      throw new Error(
        `${id}: client bundle imports "${source}", which the DSH client module table does not provide; `
        + 'collaborate through cordis services or use a type-only import',
      )
    },
  }
}

export default defineConfig([
  {
    name: 'host',
    entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: false,
    outputOptions: { entryFileNames: '[name].js' },
  },
  {
    name: 'client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    inputOptions: {
      resolve: { conditionNames: ['production', 'browser', 'import', 'module', 'default'] },
    },
    deps: {
      neverBundle: (specifier: string) => PLATFORM_MODULES.has(specifier),
      alwaysBundle: (specifier: string) => !PLATFORM_MODULES.has(specifier),
    },
    plugins: [clientBundlePurity(clientId), cssModulesInline(clientId)],
    outputOptions: {
      entryFileNames: 'client.js',
      // The loader materializes the factory lazily, after every bundle in the
      // combo script has run, so `module`/`exports` must be factory-local.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(clientId)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
