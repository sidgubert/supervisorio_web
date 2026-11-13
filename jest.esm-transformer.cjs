/**
 * Transformador do Jest para código JavaScript em ESM (`import`/`export`).
 *
 * O Jest roda em CommonJS e não entende `import`/`export`. Este transformador
 * converte para CommonJS, com esModuleInterop (o código ESM usa importações
 * padrão de módulos CommonJS, ex: `import os from "node:os"`):
 * - no backend, só as dependências publicadas apenas em ESM, listadas em
 *   transformIgnorePatterns (em tempo de execução, o Node 22.13+ as carrega
 *   normalmente);
 * - no frontend, os módulos de public/js e os próprios testes.
 */
const { createHash } = require('crypto');
const ts = require('typescript');

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  allowJs: true,
  inlineSourceMap: true,
};

/**
 * `import.meta` não existe em CommonJS (o node-opcua 2.187+ o usa). Troca pelos
 * equivalentes: o próprio arquivo é o módulo, então __filename/__dirname servem.
 */
function rewriteImportMeta(source) {
  if (!source.includes('import.meta')) return source;
  return source
    .replace(/import\.meta\.filename/g, '__filename')
    .replace(/import\.meta\.dirname/g, '__dirname')
    .replace(/import\.meta\.url/g, 'require("url").pathToFileURL(__filename).href');
}

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(rewriteImportMeta(sourceText), {
      fileName: sourcePath,
      compilerOptions,
    });
    return { code: outputText };
  },
  // `instrument` entra na chave: com cobertura (--coverage), o Jest instrumenta
  // o resultado; sem ela no cache, reaproveitaria o código não instrumentado
  // de uma execução comum e a cobertura sairia zerada.
  getCacheKey(sourceText, sourcePath, options = {}) {
    return createHash('sha1')
      .update(ts.version)
      .update(JSON.stringify(compilerOptions))
      .update(rewriteImportMeta.toString())
      .update(sourcePath)
      .update(sourceText)
      .update(String(Boolean(options.instrument)))
      .digest('hex');
  },
};
