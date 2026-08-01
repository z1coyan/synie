export type SourceText = {
  path: string
  source: string
}

export type AggregateClientViolation = {
  path: string
  line: number
  column: number
  resource: string | null
  client: string
  operation: 'create' | 'update' | 'delete' | 'alias'
  detail: string
}

type Token = {
  kind: 'identifier' | 'string' | 'punctuation'
  text: string
  line: number
  column: number
}

type ClientDeclaration = {
  name: string
  resource: string
  path: string
}

const WRITE_OPERATIONS = new Set(['create', 'update', 'delete'])
const LEGACY_STOCK_CLIENT_PROPERTIES = new Set(['docClient', 'itemClient'])
const ALIAS_PROPERTY_NAMES = new Set(['client', ...LEGACY_STOCK_CLIENT_PROPERTIES])

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let offset = 0
  let line = 1
  let column = 1

  const advance = () => {
    const char = source[offset++]!
    if (char === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
    return char
  }

  while (offset < source.length) {
    const char = source[offset]!
    if (/\s/.test(char)) {
      advance()
      continue
    }
    if (char === '/' && source[offset + 1] === '/') {
      while (offset < source.length && advance() !== '\n') {}
      continue
    }
    if (char === '/' && source[offset + 1] === '*') {
      advance()
      advance()
      while (offset < source.length) {
        if (source[offset] === '*' && source[offset + 1] === '/') {
          advance()
          advance()
          break
        }
        advance()
      }
      continue
    }

    const startLine = line
    const startColumn = column
    if (char === '"' || char === "'" || char === '`') {
      const quote = advance()
      let value = ''
      while (offset < source.length) {
        const current = advance()
        if (current === '\\') {
          if (offset < source.length) value += advance()
          continue
        }
        if (current === quote) break
        value += current
      }
      tokens.push({ kind: 'string', text: value, line: startLine, column: startColumn })
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      let value = ''
      while (offset < source.length && /[A-Za-z0-9_$]/.test(source[offset]!)) {
        value += advance()
      }
      tokens.push({ kind: 'identifier', text: value, line: startLine, column: startColumn })
      continue
    }
    tokens.push({
      kind: 'punctuation',
      text: advance(),
      line: startLine,
      column: startColumn,
    })
  }
  return tokens
}

function declarationsFrom(source: SourceText, tokens: readonly Token[]): ClientDeclaration[] {
  const declarations: ClientDeclaration[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== 'unboundResourceClient') continue
    if (tokens[index + 1]?.text !== '(' || tokens[index + 2]?.kind !== 'string') continue
    let equals = index - 1
    while (equals >= 0 && tokens[equals]?.text !== '=' && index - equals < 20) equals -= 1
    if (equals < 0 || tokens[equals]?.text !== '=') continue
    let declarationKeyword = equals - 1
    while (
      declarationKeyword >= 0 &&
      !['const', 'let', 'var'].includes(tokens[declarationKeyword]!.text) &&
      equals - declarationKeyword < 20
    ) declarationKeyword -= 1
    const name = tokens[declarationKeyword + 1]
    if (
      declarationKeyword < 0 ||
      !name ||
      name.kind !== 'identifier' ||
      declarationKeyword >= equals
    ) continue
    declarations.push({
      name: name.text,
      resource: tokens[index + 2]!.text,
      path: source.path,
    })
  }
  return declarations
}

function uniqueDeclarations(
  declarations: readonly ClientDeclaration[],
): Map<string, ClientDeclaration> {
  const grouped = new Map<string, ClientDeclaration[]>()
  for (const declaration of declarations) {
    grouped.set(declaration.name, [
      ...(grouped.get(declaration.name) ?? []),
      declaration,
    ])
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, group]) => new Set(group.map((entry) => entry.resource)).size === 1)
      .map(([name, group]) => [name, group[0]!]),
  )
}

function importBindings(
  tokens: readonly Token[],
  declarations: ReadonlyMap<string, ClientDeclaration>,
  aggregateResources: ReadonlySet<string>,
): {
  identifiers: Map<string, ClientDeclaration>
  namespaces: Set<string>
} {
  const identifiers = new Map<string, ClientDeclaration>()
  const namespaces = new Set<string>()

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== 'import') continue
    let cursor = index + 1
    if (tokens[cursor]?.text === 'type') cursor += 1
    if (tokens[cursor]?.text === '*') {
      if (tokens[cursor + 1]?.text === 'as' && tokens[cursor + 2]?.kind === 'identifier') {
        namespaces.add(tokens[cursor + 2]!.text)
      }
      continue
    }
    if (tokens[cursor]?.text !== '{') continue
    cursor += 1
    while (cursor < tokens.length && tokens[cursor]?.text !== '}') {
      if (tokens[cursor]?.kind !== 'identifier') {
        cursor += 1
        continue
      }
      const importedName = tokens[cursor]!.text
      let localName = importedName
      if (tokens[cursor + 1]?.text === 'as' && tokens[cursor + 2]?.kind === 'identifier') {
        localName = tokens[cursor + 2]!.text
        cursor += 2
      }
      const known = declarations.get(importedName)
      if (known && aggregateResources.has(known.resource)) identifiers.set(localName, known)
      cursor += 1
    }
  }
  return { identifiers, namespaces }
}

function namespaceClient(
  tokens: readonly Token[],
  start: number,
  namespaces: ReadonlySet<string>,
  declarations: ReadonlyMap<string, ClientDeclaration>,
  aggregateResources: ReadonlySet<string>,
): ClientDeclaration | null {
  const namespace = tokens[start]
  if (!namespace || namespace.kind !== 'identifier' || !namespaces.has(namespace.text)) return null
  if (tokens[start + 1]?.text === '.' && tokens[start + 2]?.kind === 'identifier') {
    const known = declarations.get(tokens[start + 2]!.text)
    return known && aggregateResources.has(known.resource) ? known : null
  }
  if (
    tokens[start + 1]?.text === '[' &&
    tokens[start + 2]?.kind === 'string' &&
    tokens[start + 3]?.text === ']'
  ) {
    const known = declarations.get(tokens[start + 2]!.text)
    return known && aggregateResources.has(known.resource) ? known : null
  }
  return null
}

function addSimpleAliases(
  tokens: readonly Token[],
  identifiers: Map<string, ClientDeclaration>,
  namespaces: ReadonlySet<string>,
  declarations: ReadonlyMap<string, ClientDeclaration>,
  aggregateResources: ReadonlySet<string>,
): void {
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < tokens.length - 3; index += 1) {
      if (!['const', 'let', 'var'].includes(tokens[index]!.text)) continue
      const name = tokens[index + 1]
      if (!name || name.kind !== 'identifier') continue
      let equals = index + 2
      while (equals < tokens.length && tokens[equals]?.text !== '=' && equals - index < 20) equals += 1
      if (tokens[equals]?.text !== '=') continue
      const initializer = tokens[equals + 1]
      let known = initializer?.kind === 'identifier'
        ? identifiers.get(initializer.text) ?? null
        : null
      known ??= namespaceClient(
        tokens,
        equals + 1,
        namespaces,
        declarations,
        aggregateResources,
      )
      if (known && !identifiers.has(name.text)) {
        identifiers.set(name.text, known)
        changed = true
      }
    }
  }
}

function receiverBefore(
  tokens: readonly Token[],
  end: number,
  identifiers: ReadonlyMap<string, ClientDeclaration>,
  namespaces: ReadonlySet<string>,
  declarations: ReadonlyMap<string, ClientDeclaration>,
  aggregateResources: ReadonlySet<string>,
): { known: ClientDeclaration | null; legacy: string | null } {
  let cursor = end
  if (tokens[cursor]?.text === '?') cursor -= 1
  const direct = tokens[cursor]
  if (direct?.kind === 'identifier') {
    const known = identifiers.get(direct.text) ?? null
    if (known) return { known, legacy: null }
    if (LEGACY_STOCK_CLIENT_PROPERTIES.has(direct.text)) {
      return { known: null, legacy: direct.text }
    }
    const namespaceStart = cursor - 2
    if (tokens[cursor - 1]?.text === '.') {
      const namespaceKnown = namespaceClient(
        tokens,
        namespaceStart,
        namespaces,
        declarations,
        aggregateResources,
      )
      if (namespaceKnown) return { known: namespaceKnown, legacy: null }
    }
  }
  if (direct?.text === ']') {
    let open = cursor - 1
    while (open >= 0 && tokens[open]?.text !== '[' && cursor - open < 10) open -= 1
    if (tokens[open]?.text === '[' && tokens[open + 1]?.kind === 'string') {
      const property = tokens[open + 1]!.text
      if (LEGACY_STOCK_CLIENT_PROPERTIES.has(property)) {
        return { known: null, legacy: property }
      }
      const namespaceKnown = namespaceClient(
        tokens,
        open - 1,
        namespaces,
        declarations,
        aggregateResources,
      )
      if (namespaceKnown) return { known: namespaceKnown, legacy: null }
    }
  }
  return { known: null, legacy: null }
}

function clientAt(
  tokens: readonly Token[],
  index: number,
  identifiers: ReadonlyMap<string, ClientDeclaration>,
  namespaces: ReadonlySet<string>,
  declarations: ReadonlyMap<string, ClientDeclaration>,
  aggregateResources: ReadonlySet<string>,
): ClientDeclaration | null {
  const token = tokens[index]
  if (token?.kind === 'identifier') {
    return identifiers.get(token.text) ?? namespaceClient(
      tokens,
      index,
      namespaces,
      declarations,
      aggregateResources,
    )
  }
  return null
}

/**
 * 从 unboundResourceClient 声明解析客户端，再扫描聚合头/子资源的普通写调用。
 * 词法扫描会跳过注释与字符串，并追踪 import alias、namespace 与简单 const alias。
 */
export function findAggregateClientWriteViolations(
  sources: readonly SourceText[],
  aggregateResources: ReadonlySet<string>,
): AggregateClientViolation[] {
  const parsed = sources.map((source) => ({ source, tokens: tokenize(source.source) }))
  const declarations = uniqueDeclarations(
    parsed.flatMap(({ source, tokens }) => declarationsFrom(source, tokens)),
  )
  const violations: AggregateClientViolation[] = []
  const seen = new Set<string>()

  const report = (
    path: string,
    token: Token,
    violation: Omit<AggregateClientViolation, 'path' | 'line' | 'column'>,
  ) => {
    const found = {
      path,
      line: token.line,
      column: token.column,
      ...violation,
    }
    const key = `${found.path}:${found.line}:${found.column}:${found.operation}:${found.client}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push(found)
  }

  for (const { source, tokens } of parsed) {
    const { identifiers, namespaces } = importBindings(
      tokens,
      declarations,
      aggregateResources,
    )
    for (const known of declarations.values()) {
      if (known.path === source.path && aggregateResources.has(known.resource)) {
        identifiers.set(known.name, known)
      }
    }
    addSimpleAliases(tokens, identifiers, namespaces, declarations, aggregateResources)

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!
      if (WRITE_OPERATIONS.has(token.text)) {
        let access: ReturnType<typeof receiverBefore> | null = null
        let called = false
        if (tokens[index - 1]?.text === '.') {
          access = receiverBefore(
            tokens,
            index - 2,
            identifiers,
            namespaces,
            declarations,
            aggregateResources,
          )
          called = tokens[index + 1]?.text === '('
        } else if (
          token.kind === 'string' &&
          tokens[index - 1]?.text === '[' &&
          tokens[index + 1]?.text === ']'
        ) {
          access = receiverBefore(
            tokens,
            index - 2,
            identifiers,
            namespaces,
            declarations,
            aggregateResources,
          )
          called = tokens[index + 2]?.text === '('
        }
        if (called && access?.known) {
          report(source.path, token, {
            resource: access.known.resource,
            client: access.known.name,
            operation: token.text as 'create' | 'update' | 'delete',
            detail: `聚合资源 ${access.known.resource} 禁止经 ${access.known.name}.${token.text} 普通写入`,
          })
        } else if (called && access?.legacy) {
          report(source.path, token, {
            resource: null,
            client: access.legacy,
            operation: token.text as 'create' | 'update' | 'delete',
            detail: `旧库存配置 ${access.legacy}.${token.text} 会绕过聚合 Draft`,
          })
        }
      }

      if (
        token.kind === 'identifier' &&
        ALIAS_PROPERTY_NAMES.has(token.text) &&
        tokens[index + 1]?.text === ':'
      ) {
        const known = clientAt(
          tokens,
          index + 2,
          identifiers,
          namespaces,
          declarations,
          aggregateResources,
        )
        if (known) {
          report(source.path, token, {
            resource: known.resource,
            client: known.name,
            operation: 'alias',
            detail: `聚合资源 ${known.resource} client 被装入 ${token.text} 属性，禁止绕过 Draft adapter`,
          })
        }
      }
    }
  }

  return violations.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.operation.localeCompare(right.operation),
  )
}
