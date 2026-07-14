import generate from '@babel/generator'
import { parse, type ParserPlugin } from '@babel/parser'
import traverse, { type NodePath } from '@babel/traverse'
import * as t from '@babel/types'

export type YeetTransformOptions = {
  moduleNames?: readonly string[]
  streamModuleNames?: readonly string[]
}

export type YeetTransformResult = {
  code: string
  map: unknown
  optimized: number
  bailed: number
}

type CombinatorName = 'either' | 'validate' | 'firstOf' | 'collect'
type EitherIntrinsicName =
  | 'capture'
  | 'ensure'
  | 'ensureNotNull'
  | 'left'
  | 'right'
type HelperKey = 'raise' | 'left' | 'right'
type StreamItemHelperName = 'chunks' | 'lines' | 'ndjson' | 'sse'

type HelperIds = {
  readonly ids: Map<HelperKey, t.Identifier>
  readonly declaration: t.ImportDeclaration
}

type TransformState = {
  readonly moduleNames: readonly string[]
  readonly streamModuleNames: readonly string[]
  readonly helpers: Map<string, HelperIds>
  optimized: number
  bailed: number
}

type YieldRewrite = {
  readonly path: NodePath<t.YieldExpression>
  readonly statement: NodePath<t.Statement>
  readonly replacement: t.Expression
  readonly prelude: t.Statement[]
  readonly removeStatement?: boolean
}

type EitherParameter = {
  readonly raiseName?: string
}

type EitherIntrinsicCall = {
  readonly name: EitherIntrinsicName
  readonly call: NodePath<t.CallExpression>
  readonly arguments: readonly t.Expression[]
}

const DEFAULT_MODULE_NAMES = ['@big-time/yeet', 'yeet']
const DEFAULT_STREAM_MODULE_NAMES = ['@big-time/yeet/stream', 'yeet/stream']
const COMBINATOR_NAMES = new Set<CombinatorName>([
  'either',
  'validate',
  'firstOf',
  'collect',
])
const EITHER_INTRINSIC_NAMES = new Set<EitherIntrinsicName>([
  'capture',
  'ensure',
  'ensureNotNull',
  'left',
  'right',
])
const STREAM_ITEM_HELPERS = new Set<StreamItemHelperName>([
  'chunks',
  'lines',
  'ndjson',
  'sse',
])
const HELPER_IMPORTS = {
  raise: 'raise',
  left: 'left',
  right: 'right',
} satisfies Record<HelperKey, string>
const MAYBE_COMBINATOR = /\b(?:either|validate|firstOf|collect)\b/
const PARSER_PLUGINS: ParserPlugin[] = ['typescript', 'jsx']

export function transformYeet(
  code: string,
  id: string,
  options: YeetTransformOptions = {},
): YeetTransformResult | null {
  if (!MAYBE_COMBINATOR.test(code)) return null

  const ast = parse(code, {
    sourceType: 'module',
    sourceFilename: id,
    plugins: PARSER_PLUGINS,
  })

  const state: TransformState = {
    moduleNames: options.moduleNames ?? DEFAULT_MODULE_NAMES,
    streamModuleNames: options.streamModuleNames ?? DEFAULT_STREAM_MODULE_NAMES,
    helpers: new Map(),
    optimized: 0,
    bailed: 0,
  }

  traverse(ast, {
    CallExpression(path) {
      const target = getYeetCombinatorImport(path, state.moduleNames)
      if (target === undefined) return

      const ok = lowerCombinatorCall(path, target, state)
      if (ok) state.optimized++
      else state.bailed++
    },
  })

  if (state.optimized === 0) return null

  const output = generate(
    ast.program,
    {
      sourceMaps: true,
      sourceFileName: id,
      jsescOption: { minimal: true },
    },
    code,
  )

  return {
    code: output.code,
    map: output.map,
    optimized: state.optimized,
    bailed: state.bailed,
  }
}

function getYeetCombinatorImport(
  path: NodePath<t.CallExpression>,
  moduleNames: readonly string[],
): { readonly name: CombinatorName; readonly source: string } | undefined {
  if (!path.get('callee').isIdentifier()) return undefined
  const callee = path.get('callee') as NodePath<t.Identifier>
  const binding = path.scope.getBinding(callee.node.name)
  const bindingPath = binding?.path
  if (!bindingPath?.isImportSpecifier()) return undefined

  const imported = bindingPath.node.imported
  const name = t.isIdentifier(imported) ? imported.name : imported.value
  if (!isCombinatorName(name)) return undefined

  const declaration = bindingPath.parentPath
  if (!declaration.isImportDeclaration()) return undefined

  const source = declaration.node.source.value
  return moduleNames.includes(source) ? { name, source } : undefined
}

function isCombinatorName(name: string): name is CombinatorName {
  return COMBINATOR_NAMES.has(name as CombinatorName)
}

function getEitherIntrinsicCall(
  path: NodePath<t.YieldExpression>,
  source: string,
): EitherIntrinsicCall | undefined {
  if (!path.node.delegate) return undefined
  const argument = path.get('argument')
  if (!argument.isExpression()) return undefined

  const expression = skipTransparentExpressionPath(argument)
  if (!expression.isCallExpression()) return undefined
  const callee = expression.get('callee')
  if (!callee.isIdentifier()) return undefined

  const name = getImportedName(callee, source)
  if (
    name === undefined ||
    !EITHER_INTRINSIC_NAMES.has(name as EitherIntrinsicName)
  ) {
    return undefined
  }

  const intrinsic = name as EitherIntrinsicName
  const expectedArguments =
    intrinsic === 'ensure' || intrinsic === 'ensureNotNull' ? 2 : 1
  if (expression.node.arguments.length !== expectedArguments) return undefined

  const args: t.Expression[] = []
  for (const input of expression.node.arguments) {
    if (!t.isExpression(input)) return undefined
    args.push(input)
  }

  return { name: intrinsic, call: expression, arguments: args }
}

function getImportedName(
  path: NodePath<t.Identifier>,
  source: string,
): string | undefined {
  const bindingPath = path.scope.getBinding(path.node.name)?.path
  if (!bindingPath?.isImportSpecifier()) return undefined

  const declaration = bindingPath.parentPath
  if (
    !declaration.isImportDeclaration() ||
    declaration.node.source.value !== source
  ) {
    return undefined
  }

  const imported = bindingPath.node.imported
  return t.isIdentifier(imported) ? imported.name : imported.value
}

function lowerCombinatorCall(
  callPath: NodePath<t.CallExpression>,
  target: { readonly name: CombinatorName; readonly source: string },
  state: TransformState,
): boolean {
  switch (target.name) {
    case 'either':
      return lowerEitherCall(callPath, target.source, state)
    case 'validate':
      return lowerValidateCall(callPath, target.source, state)
    case 'firstOf':
      return lowerFirstOfCall(callPath, target.source, state)
    case 'collect':
      return lowerCollectCall(callPath)
  }
}

function lowerEitherCall(
  callPath: NodePath<t.CallExpression>,
  source: string,
  state: TransformState,
): boolean {
  const args = callPath.get('arguments')
  if (args.length !== 1) return false

  const fnPath = args[0]
  if (!fnPath?.isFunctionExpression()) return false
  if (!fnPath.node.generator) return false
  if (fnPath.node.id !== null) return false
  if (fnPath.node.params.length > 1) return false

  const parameter = parseEitherParameter(fnPath)
  if (parameter === undefined) return false
  const raiseName = parameter.raiseName
  if (!isSafeEitherGenerator(fnPath, raiseName, state.streamModuleNames)) {
    return false
  }

  const programPath = callPath.scope.getProgramParent().path
  if (!programPath.isProgram()) return false

  const helpers = ensureHelpers(programPath, source, state, ['right'])
  const rightHelper = getHelper(helpers, 'right')
  const raiseHelper =
    raiseName === undefined
      ? undefined
      : getHelper(ensureHelpers(programPath, source, state, ['raise']), 'raise')

  if (raiseHelper !== undefined) {
    rewriteRaiseReferences(fnPath, raiseName, raiseHelper)
  }
  const leftHelper = usesEitherFailureIntrinsic(fnPath, source)
    ? getHelper(ensureHelpers(programPath, source, state, ['left']), 'left')
    : undefined
  rewriteYieldExpressions(fnPath, source, leftHelper)
  rewriteEitherReturns(fnPath, rightHelper)
  appendFallthroughReturn(fnPath, rightHelper)

  const body = fnPath.node.body
  const iife = t.callExpression(
    t.arrowFunctionExpression([], body, fnPath.node.async),
    [],
  )
  callPath.replaceWith(iife)
  return true
}

function lowerValidateCall(
  callPath: NodePath<t.CallExpression>,
  source: string,
  state: TransformState,
): boolean {
  const args = callPath.get('arguments')
  if (args.length !== 1) return false

  const fnPath = args[0]
  if (!fnPath?.isFunctionExpression()) return false
  if (!fnPath.node.generator || fnPath.node.async) return false
  if (fnPath.node.id !== null) return false
  if (fnPath.node.params.length > 1) return false

  const checkParam = fnPath.get('params')[0]
  if (checkParam !== undefined && !checkParam.isIdentifier()) return false
  const checkName = checkParam?.isIdentifier()
    ? checkParam.node.name
    : undefined
  if (!isSafeValidateGenerator(fnPath, checkName)) return false

  const programPath = callPath.scope.getProgramParent().path
  if (!programPath.isProgram()) return false

  const helpers = ensureHelpers(programPath, source, state, ['left', 'right'])
  const leftHelper = getHelper(helpers, 'left')
  const rightHelper = getHelper(helpers, 'right')
  const errors = fnPath.scope.generateUidIdentifier('yeetErrors')

  fnPath.node.body.body.unshift(
    t.variableDeclaration('let', [t.variableDeclarator(t.cloneNode(errors))]),
  )
  rewriteValidateYields(fnPath, checkName, errors)
  rewriteFinalizingReturns(fnPath, (ret) =>
    finishWithErrors(ret, errors, leftHelper, rightHelper),
  )
  fnPath.node.body.body.push(
    t.returnStatement(
      finishWithErrors(
        t.identifier('undefined'),
        errors,
        leftHelper,
        rightHelper,
      ),
    ),
  )

  callPath.replaceWith(
    t.callExpression(t.arrowFunctionExpression([], fnPath.node.body), []),
  )
  return true
}

function lowerFirstOfCall(
  callPath: NodePath<t.CallExpression>,
  source: string,
  state: TransformState,
): boolean {
  const args = callPath.get('arguments')
  if (args.length !== 1) return false

  const fnPath = args[0]
  if (!fnPath?.isFunctionExpression()) return false
  if (!fnPath.node.generator || fnPath.node.async) return false
  if (fnPath.node.id !== null) return false
  if (fnPath.node.params.length !== 0) return false
  if (!isSafeYieldStatementGenerator(fnPath, false)) return false

  const programPath = callPath.scope.getProgramParent().path
  if (!programPath.isProgram()) return false

  const helpers = ensureHelpers(programPath, source, state, ['left', 'right'])
  const leftHelper = getHelper(helpers, 'left')
  const rightHelper = getHelper(helpers, 'right')
  const errors = fnPath.scope.generateUidIdentifier('yeetErrors')

  fnPath.node.body.body.unshift(
    t.variableDeclaration('let', [t.variableDeclarator(t.cloneNode(errors))]),
  )
  rewriteFirstOfYields(fnPath, errors, rightHelper)
  rewriteFinalizingReturns(fnPath, (ret) =>
    finishWithErrors(ret, errors, leftHelper, rightHelper),
  )
  fnPath.node.body.body.push(
    t.returnStatement(
      finishWithErrors(
        t.identifier('undefined'),
        errors,
        leftHelper,
        rightHelper,
      ),
    ),
  )

  callPath.replaceWith(
    t.callExpression(t.arrowFunctionExpression([], fnPath.node.body), []),
  )
  return true
}

function lowerCollectCall(callPath: NodePath<t.CallExpression>): boolean {
  const args = callPath.get('arguments')
  if (args.length !== 1) return false

  const fnPath = args[0]
  if (!fnPath?.isFunctionExpression()) return false
  if (!fnPath.node.generator || fnPath.node.async) return false
  if (fnPath.node.id !== null) return false
  if (fnPath.node.params.length !== 0) return false
  if (!isSafeYieldStatementGenerator(fnPath, false)) return false

  const errors = fnPath.scope.generateUidIdentifier('yeetErrors')
  const values = fnPath.scope.generateUidIdentifier('yeetValues')

  fnPath.node.body.body.unshift(
    t.variableDeclaration('const', [
      t.variableDeclarator(t.cloneNode(errors), t.arrayExpression([])),
    ]),
    t.variableDeclaration('const', [
      t.variableDeclarator(t.cloneNode(values), t.arrayExpression([])),
    ]),
  )
  rewriteCollectYields(fnPath, errors, values)
  rewriteCollectReturns(fnPath, errors, values)
  fnPath.node.body.body.push(t.returnStatement(collectedObject(errors, values)))

  callPath.replaceWith(
    t.callExpression(t.arrowFunctionExpression([], fnPath.node.body), []),
  )
  return true
}

function parseEitherParameter(
  fnPath: NodePath<t.FunctionExpression>,
): EitherParameter | undefined {
  const parameter = fnPath.get('params')[0]
  if (parameter === undefined) return {}
  if (parameter.isIdentifier()) return { raiseName: parameter.node.name }
  if (!parameter.isObjectPattern()) return undefined

  const properties = parameter.get('properties')
  if (properties.length !== 1) return undefined
  const property = properties[0]
  if (!property?.isObjectProperty() || property.node.computed) return undefined

  const key = property.get('key')
  const value = property.get('value')
  if (!key.isIdentifier({ name: 'raise' }) || !value.isIdentifier()) {
    return undefined
  }

  return { raiseName: value.node.name }
}

function usesEitherFailureIntrinsic(
  fnPath: NodePath<t.FunctionExpression>,
  source: string,
): boolean {
  let usesFailureIntrinsic = false

  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    YieldExpression(path: NodePath<t.YieldExpression>) {
      const intrinsic = getEitherIntrinsicCall(path, source)
      if (intrinsic?.name === 'ensure' || intrinsic?.name === 'ensureNotNull') {
        usesFailureIntrinsic = true
        path.stop()
      }
    },
  })

  return usesFailureIntrinsic
}

function isSafeEitherGenerator(
  fnPath: NodePath<t.FunctionExpression>,
  raiseName: string | undefined,
  streamModuleNames: readonly string[],
): boolean {
  const raiseBinding =
    raiseName === undefined ? undefined : fnPath.scope.getBinding(raiseName)
  let safe = true

  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    ThisExpression(path: NodePath<t.ThisExpression>) {
      safe = false
      path.stop()
    },
    Identifier(path: NodePath<t.Identifier>) {
      if (!safe) return

      if (path.node.name === 'arguments' && path.isReferenced()) {
        safe = false
        path.stop()
        return
      }

      if (
        raiseName !== undefined &&
        path.node.name === raiseName &&
        path.scope.getBinding(raiseName)?.path === path &&
        path !== raiseBinding?.path
      ) {
        safe = false
        path.stop()
        return
      }

      if (
        raiseBinding !== undefined &&
        path.node.name === raiseName &&
        path !== raiseBinding.path &&
        !raiseBinding.path.isAncestor(path) &&
        path.isReferenced() &&
        path.scope.getBinding(raiseName) === raiseBinding &&
        !isAllowedRaiseReference(path)
      ) {
        safe = false
        path.stop()
      }
    },
    YieldExpression(path: NodePath<t.YieldExpression>) {
      if (!isLowerableYield(path, streamModuleNames)) {
        safe = false
        path.stop()
      }
    },
  })

  return safe
}

function isSafeValidateGenerator(
  fnPath: NodePath<t.FunctionExpression>,
  checkName: string | undefined,
): boolean {
  const checkBinding =
    checkName === undefined ? undefined : fnPath.scope.getBinding(checkName)
  let safe = true

  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    ThisExpression(path: NodePath<t.ThisExpression>) {
      safe = false
      path.stop()
    },
    Identifier(path: NodePath<t.Identifier>) {
      if (!safe) return

      if (path.node.name === 'arguments' && path.isReferenced()) {
        safe = false
        path.stop()
        return
      }

      if (
        checkName !== undefined &&
        path.node.name === checkName &&
        path.scope.getBinding(checkName)?.path === path &&
        path !== checkBinding?.path
      ) {
        safe = false
        path.stop()
        return
      }

      if (
        checkBinding !== undefined &&
        path.node.name === checkName &&
        path.isReferenced() &&
        path.scope.getBinding(checkName) === checkBinding &&
        !isAllowedCheckReference(path)
      ) {
        safe = false
        path.stop()
      }
    },
    YieldExpression(path: NodePath<t.YieldExpression>) {
      if (!isValidateYield(path, checkBinding)) {
        safe = false
        path.stop()
      }
    },
  })

  return safe
}

function isSafeYieldStatementGenerator(
  fnPath: NodePath<t.FunctionExpression>,
  delegate: boolean,
): boolean {
  let safe = true

  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    ThisExpression(path: NodePath<t.ThisExpression>) {
      safe = false
      path.stop()
    },
    Identifier(path: NodePath<t.Identifier>) {
      if (path.node.name === 'arguments' && path.isReferenced()) {
        safe = false
        path.stop()
      }
    },
    YieldExpression(path: NodePath<t.YieldExpression>) {
      const argument = path.node.argument
      if (
        path.node.delegate !== delegate ||
        argument === null ||
        argument === undefined ||
        !isDirectYieldExpressionStatement(path)
      ) {
        safe = false
        path.stop()
      }
    },
  })

  return safe
}

function isValidateYield(
  path: NodePath<t.YieldExpression>,
  checkBinding: ReturnType<
    NodePath<t.FunctionExpression>['scope']['getBinding']
  >,
): boolean {
  if (checkBinding === undefined) return false
  const argument = path.node.argument
  if (!path.node.delegate || !t.isCallExpression(argument)) return false
  if (argument.arguments.length !== 1) return false

  const input = argument.arguments[0]
  if (!t.isExpression(input) || !isPlausibleEitherExpression(input)) {
    return false
  }

  const callee = argument.callee
  if (!t.isIdentifier(callee)) return false
  const callPath = path.get('argument')
  if (!callPath.isCallExpression()) return false
  const calleePath = callPath.get('callee')
  if (!calleePath.isIdentifier()) return false
  if (calleePath.scope.getBinding(callee.name) !== checkBinding) return false

  const statement = path.getStatementParent()
  return statement !== null && isDirectLowerableYieldPosition(path, statement)
}

function isAllowedCheckReference(path: NodePath<t.Identifier>): boolean {
  const call = path.parentPath
  if (!call.isCallExpression({ callee: path.node })) return false
  const parent = call.parentPath
  return parent.isYieldExpression() && parent.node.delegate
}

function isDirectYieldExpressionStatement(
  path: NodePath<t.YieldExpression>,
): boolean {
  const statement = path.getStatementParent()
  if (statement === null || !statement.inList) return false
  if (!statement.isExpressionStatement()) return false
  return statement.get('expression') === path
}

function isLowerableYield(
  path: NodePath<t.YieldExpression>,
  streamModuleNames: readonly string[],
): boolean {
  const argument = path.node.argument
  if (!path.node.delegate || argument === null || argument === undefined) {
    return false
  }
  const argumentPath = path.get('argument')
  if (
    (!argumentPath.isExpression() ||
      !isPlausibleEitherExpressionPath(argumentPath)) &&
    !isProvenStreamItemYield(path, argument, streamModuleNames)
  ) {
    return false
  }

  const statement = path.getStatementParent()
  if (statement === null) return false
  return isDirectLowerableYieldPosition(path, statement)
}

function isPlausibleEitherExpression(node: t.Expression): boolean {
  const expression = skipTransparentExpressionNode(node)
  if (t.isCallExpression(expression)) return true
  if (
    t.isAwaitExpression(expression) &&
    t.isCallExpression(expression.argument)
  ) {
    return true
  }
  return false
}

function isPlausibleEitherExpressionPath(
  path: NodePath<t.Expression>,
  seen: Set<t.Identifier> = new Set(),
): boolean {
  const expression = skipTransparentExpressionPath(path)
  if (expression.isCallExpression()) return true

  if (expression.isAwaitExpression()) {
    const argument = expression.get('argument')
    if (!argument.isExpression()) return false
    const awaited = skipTransparentExpressionPath(argument)
    return (
      awaited.isCallExpression() ||
      isPlausibleEitherExpressionPath(awaited, seen)
    )
  }

  if (!expression.isIdentifier()) return false
  const binding = expression.scope.getBinding(expression.node.name)
  if (
    binding === undefined ||
    binding.kind !== 'const' ||
    !binding.constant ||
    seen.has(binding.identifier)
  ) {
    return false
  }

  const initializer = getConstBindingInitializer(binding.path)
  if (initializer === undefined) return false

  seen.add(binding.identifier)
  return isPlausibleEitherExpressionPath(initializer, seen)
}

function getConstBindingInitializer(
  bindingPath: NodePath<t.Node>,
): NodePath<t.Expression> | undefined {
  let declarator: NodePath<t.VariableDeclarator>
  if (bindingPath.isVariableDeclarator()) {
    declarator = bindingPath
  } else {
    if (!bindingPath.isIdentifier()) return undefined
    const parent = bindingPath.parentPath
    if (!parent.isVariableDeclarator() || parent.node.id !== bindingPath.node) {
      return undefined
    }
    declarator = parent
  }

  const declaration = declarator.parentPath
  if (
    !declaration.isVariableDeclaration() ||
    declaration.node.kind !== 'const'
  ) {
    return undefined
  }

  const initializer = declarator.get('init')
  return initializer.isExpression() ? initializer : undefined
}

function isProvenStreamItemYield(
  path: NodePath<t.YieldExpression>,
  node: t.Expression,
  streamModuleNames: readonly string[],
): boolean {
  const expression = skipTransparentExpressionNode(node)
  if (!t.isIdentifier(expression)) return false

  const binding = path.scope.getBinding(expression.name)
  return binding === undefined
    ? false
    : isStreamForOfBinding(binding.path, streamModuleNames)
}

function isStreamForOfBinding(
  bindingPath: NodePath<t.Node>,
  streamModuleNames: readonly string[],
): boolean {
  let declarator: NodePath<t.VariableDeclarator>
  if (bindingPath.isVariableDeclarator()) {
    declarator = bindingPath
  } else {
    if (!bindingPath.isIdentifier()) return false

    const parent = bindingPath.parentPath
    if (!parent.isVariableDeclarator()) return false
    if (parent.get('id') !== bindingPath) return false
    declarator = parent
  }

  if (!declarator.get('id').isIdentifier()) return false

  const declaration = declarator.parentPath
  if (!declaration.isVariableDeclaration()) return false
  if (declaration.node.kind !== 'const') return false

  const forOf = declaration.parentPath
  if (!forOf.isForOfStatement()) return false
  if (!forOf.node.await) return false
  if (forOf.get('left') !== declaration) return false

  return isStreamItemSource(forOf.get('right'), streamModuleNames)
}

function isStreamItemSource(
  path: NodePath<t.Expression>,
  streamModuleNames: readonly string[],
): boolean {
  const expression = skipTransparentExpressionPath(path)
  if (!expression.isCallExpression()) return false

  const callee = expression.get('callee')
  if (!callee.isIdentifier()) return false

  const bindingPath = expression.scope.getBinding(callee.node.name)?.path
  if (!bindingPath?.isImportSpecifier()) return false

  const imported = bindingPath.node.imported
  const name = t.isIdentifier(imported) ? imported.name : imported.value
  if (!STREAM_ITEM_HELPERS.has(name as StreamItemHelperName)) return false

  const declaration = bindingPath.parentPath
  return (
    declaration.isImportDeclaration() &&
    streamModuleNames.includes(declaration.node.source.value)
  )
}

function skipTransparentExpressionNode(node: t.Expression): t.Expression {
  if (
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node)
  ) {
    return skipTransparentExpressionNode(node.expression)
  }
  if (t.isParenthesizedExpression(node)) {
    return skipTransparentExpressionNode(node.expression)
  }
  return node
}

function skipTransparentExpressionPath(
  path: NodePath<t.Expression>,
): NodePath<t.Expression> {
  let current: NodePath<any> = path
  while (
    current.isTSAsExpression() ||
    current.isTSSatisfiesExpression() ||
    current.isTSNonNullExpression() ||
    current.isParenthesizedExpression()
  ) {
    current = current.get('expression') as NodePath<any>
  }
  return current as NodePath<t.Expression>
}

function isDirectLowerableYieldPosition(
  path: NodePath<t.YieldExpression>,
  statement: NodePath<t.Statement>,
): boolean {
  if (!statement.inList) return false

  const expression = skipTransparentParents(path)
  const parent = expression.parentPath
  if (parent === null) return false

  if (statement.isExpressionStatement()) {
    return parent === statement && statement.get('expression') === expression
  }

  if (statement.isReturnStatement() || statement.isThrowStatement()) {
    return parent === statement
  }

  if (statement.isVariableDeclaration()) {
    return (
      statement.node.declarations.length === 1 &&
      parent.isVariableDeclarator() &&
      parent.parentPath === statement &&
      parent.get('init') === expression
    )
  }

  if (statement.isIfStatement()) return statement.get('test') === expression
  if (statement.isSwitchStatement()) {
    return statement.get('discriminant') === expression
  }

  return false
}

function skipTransparentParents(path: NodePath<any>): NodePath<any> {
  let current = path
  while (
    current.parentPath !== null &&
    (current.parentPath.isTSAsExpression() ||
      current.parentPath.isTSSatisfiesExpression() ||
      current.parentPath.isTSNonNullExpression() ||
      current.parentPath.isParenthesizedExpression())
  ) {
    current = current.parentPath
  }
  return current
}

function isAllowedRaiseReference(path: NodePath<t.Identifier>): boolean {
  const call = path.parentPath
  if (!call.isCallExpression({ callee: path.node })) return false

  const parent = call.parentPath
  if (parent.isReturnStatement()) return true

  if (!parent.isAwaitExpression()) return false
  const maybeYield = parent.parentPath
  return maybeYield.isYieldExpression() && maybeYield.node.delegate
}

function ensureHelpers(
  programPath: NodePath<t.Program>,
  source: string,
  state: TransformState,
  keys: readonly HelperKey[],
): HelperIds {
  const existing = state.helpers.get(source)
  if (existing !== undefined) {
    for (const key of keys) ensureHelper(existing, programPath, key)
    return existing
  }

  const declaration = t.importDeclaration([], t.stringLiteral(source))
  const helpers = { ids: new Map<HelperKey, t.Identifier>(), declaration }
  for (const key of keys) ensureHelper(helpers, programPath, key)

  programPath.unshiftContainer('body', declaration)
  state.helpers.set(source, helpers)
  return helpers
}

function ensureHelper(
  helpers: HelperIds,
  programPath: NodePath<t.Program>,
  key: HelperKey,
): void {
  if (helpers.ids.has(key)) return

  const local = programPath.scope.generateUidIdentifier(
    `yeet${capitalize(key)}`,
  )
  helpers.ids.set(key, local)
  helpers.declaration.specifiers.push(
    t.importSpecifier(local, t.identifier(HELPER_IMPORTS[key])),
  )
}

function getHelper(helpers: HelperIds, key: HelperKey): t.Identifier {
  const helper = helpers.ids.get(key)
  if (helper === undefined) {
    throw new Error(`Missing yeet transform helper: ${key}`)
  }
  return helper
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1)
}

function rewriteRaiseReferences(
  fnPath: NodePath<t.FunctionExpression>,
  raiseName: string | undefined,
  raiseHelper: t.Identifier,
): void {
  if (raiseName === undefined) return
  const raiseBinding = fnPath.scope.getBinding(raiseName)
  if (raiseBinding === undefined) return

  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    Identifier(path: NodePath<t.Identifier>) {
      if (path === raiseBinding.path || raiseBinding.path.isAncestor(path)) {
        return
      }
      if (
        path.isReferencedIdentifier({ name: raiseName }) &&
        path.scope.getBinding(raiseName) === raiseBinding
      ) {
        path.replaceWith(t.cloneNode(raiseHelper))
      }
    },
  })
}

function rewriteYieldExpressions(
  fnPath: NodePath<t.FunctionExpression>,
  source: string,
  leftHelper: t.Identifier | undefined,
): void {
  const rewrites: YieldRewrite[] = []

  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    YieldExpression(path: NodePath<t.YieldExpression>) {
      const statement = path.getStatementParent()
      const argument = path.node.argument
      if (statement === null || argument === null) return
      rewrites.push(
        buildEitherYieldRewrite(path, statement, source, leftHelper),
      )
    },
  })

  const byStatement = new Map<NodePath<t.Statement>, t.Statement[]>()
  const removedStatements = new Set<NodePath<t.Statement>>()
  for (const rewrite of rewrites) {
    if (rewrite.removeStatement) removedStatements.add(rewrite.statement)
    else rewrite.path.replaceWith(rewrite.replacement)

    const statements = byStatement.get(rewrite.statement)
    if (statements === undefined) {
      byStatement.set(rewrite.statement, [...rewrite.prelude])
    } else {
      statements.push(...rewrite.prelude)
    }
  }

  for (const [statement, prelude] of byStatement) {
    statement.insertBefore(prelude)
    if (removedStatements.has(statement)) statement.remove()
  }
}

function buildEitherYieldRewrite(
  path: NodePath<t.YieldExpression>,
  statement: NodePath<t.Statement>,
  source: string,
  leftHelper: t.Identifier | undefined,
): YieldRewrite {
  const intrinsic = getEitherIntrinsicCall(path, source)
  if (intrinsic === undefined) {
    const argument = path.node.argument
    if (argument === null || argument === undefined) {
      throw new Error('Missing lowerable yield argument')
    }

    const temp = path.scope.generateUidIdentifier('yeet')
    return {
      path,
      statement,
      replacement: member(temp, 'value'),
      prelude: [
        constDeclaration(temp, argument),
        generatedLeftReturn(t.cloneNode(temp)),
      ],
    }
  }

  const first = intrinsic.arguments[0]
  if (first === undefined) throw new Error('Missing yeet intrinsic argument')

  if (intrinsic.name === 'left') {
    const result = path.scope.generateUidIdentifier('yeetLeft')
    return {
      path,
      statement,
      replacement: t.identifier('undefined'),
      removeStatement: isDirectYieldExpressionStatement(path),
      prelude: [
        constDeclaration(result, t.cloneNode(intrinsic.call.node, true)),
        generatedReturn(t.cloneNode(result)),
      ],
    }
  }

  if (intrinsic.name === 'right' || intrinsic.name === 'capture') {
    const value = path.scope.generateUidIdentifier('yeetValue')
    return {
      path,
      statement,
      replacement: t.cloneNode(value),
      prelude: [constDeclaration(value, t.cloneNode(first, true))],
    }
  }

  const second = intrinsic.arguments[1]
  if (second === undefined || leftHelper === undefined) {
    throw new Error('Missing yeet guard lowering helper')
  }

  const value = path.scope.generateUidIdentifier('yeetValue')
  const onFail = path.scope.generateUidIdentifier('yeetOnFail')
  const failure = t.callExpression(t.cloneNode(onFail), [])
  const fail = t.ifStatement(
    intrinsic.name === 'ensure'
      ? t.unaryExpression('!', t.cloneNode(value))
      : t.binaryExpression('==', t.cloneNode(value), t.nullLiteral()),
    generatedReturn(t.callExpression(t.cloneNode(leftHelper), [failure])),
  )

  return {
    path,
    statement,
    replacement:
      intrinsic.name === 'ensure'
        ? t.identifier('undefined')
        : t.cloneNode(value),
    removeStatement:
      intrinsic.name === 'ensure' && isDirectYieldExpressionStatement(path),
    prelude: [
      t.variableDeclaration('const', [
        t.variableDeclarator(t.cloneNode(value), t.cloneNode(first, true)),
        t.variableDeclarator(t.cloneNode(onFail), t.cloneNode(second, true)),
      ]),
      fail,
    ],
  }
}

function constDeclaration(
  id: t.Identifier,
  value: t.Expression,
): t.VariableDeclaration {
  return t.variableDeclaration('const', [
    t.variableDeclarator(t.cloneNode(id), value),
  ])
}

function rewriteValidateYields(
  fnPath: NodePath<t.FunctionExpression>,
  checkName: string | undefined,
  errors: t.Identifier,
): void {
  if (checkName === undefined) return
  const rewrites: YieldRewrite[] = []

  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    YieldExpression(path: NodePath<t.YieldExpression>) {
      const statement = path.getStatementParent()
      const input = getValidateYieldInput(path)
      if (statement === null || input === undefined) return

      const temp = path.scope.generateUidIdentifier('yeet')
      const prelude = [
        t.variableDeclaration('const', [
          t.variableDeclarator(t.cloneNode(temp), input),
        ]),
        generatedErrorPush(t.cloneNode(temp), errors),
      ]

      rewrites.push({
        path,
        statement,
        replacement: rightValueOrUndefined(temp),
        prelude,
      })
    },
  })

  for (const rewrite of rewrites) {
    rewrite.path.replaceWith(rewrite.replacement)
    rewrite.statement.insertBefore(rewrite.prelude)
  }
}

function rewriteFirstOfYields(
  fnPath: NodePath<t.FunctionExpression>,
  errors: t.Identifier,
  rightHelper: t.Identifier,
): void {
  const rewrites: {
    readonly statement: NodePath<t.Statement>
    readonly temp: t.Identifier
    readonly input: t.Expression
  }[] = []

  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    YieldExpression(path: NodePath<t.YieldExpression>) {
      const statement = path.getStatementParent()
      const input = path.node.argument
      if (statement === null || input === null || input === undefined) return

      rewrites.push({
        statement,
        temp: path.scope.generateUidIdentifier('yeet'),
        input,
      })
    },
  })

  for (const rewrite of rewrites) {
    rewrite.statement.replaceWithMultiple([
      t.variableDeclaration('const', [
        t.variableDeclarator(t.cloneNode(rewrite.temp), rewrite.input),
      ]),
      generatedRightReturn(t.cloneNode(rewrite.temp), rightHelper),
      ...errorPushStatements(t.cloneNode(rewrite.temp), errors),
    ])
  }
}

function rewriteCollectYields(
  fnPath: NodePath<t.FunctionExpression>,
  errors: t.Identifier,
  values: t.Identifier,
): void {
  const rewrites: {
    readonly statement: NodePath<t.Statement>
    readonly temp: t.Identifier
    readonly input: t.Expression
  }[] = []

  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    YieldExpression(path: NodePath<t.YieldExpression>) {
      const statement = path.getStatementParent()
      const input = path.node.argument
      if (statement === null || input === null || input === undefined) return

      rewrites.push({
        statement,
        temp: path.scope.generateUidIdentifier('yeet'),
        input,
      })
    },
  })

  for (const rewrite of rewrites) {
    rewrite.statement.replaceWithMultiple([
      t.variableDeclaration('const', [
        t.variableDeclarator(t.cloneNode(rewrite.temp), rewrite.input),
      ]),
      t.ifStatement(
        isTag(rewrite.temp, 'Left'),
        t.expressionStatement(callPush(errors, member(rewrite.temp, 'error'))),
        t.expressionStatement(callPush(values, member(rewrite.temp, 'value'))),
      ),
    ])
  }
}

function getValidateYieldInput(
  path: NodePath<t.YieldExpression>,
): t.Expression | undefined {
  const argument = path.node.argument
  if (!t.isCallExpression(argument)) return undefined
  const input = argument.arguments[0]
  return t.isExpression(input) ? input : undefined
}

function generatedLeftReturn(temp: t.Identifier): t.IfStatement {
  return t.ifStatement(
    t.binaryExpression(
      '===',
      t.memberExpression(t.cloneNode(temp), t.identifier('_tag')),
      t.stringLiteral('Left'),
    ),
    generatedReturn(t.cloneNode(temp)),
  )
}

function generatedReturn(argument: t.Expression): t.ReturnStatement {
  const statement = t.returnStatement(argument)
  ;(
    statement as t.ReturnStatement & { __yeetGenerated?: boolean }
  ).__yeetGenerated = true
  return statement
}

function generatedRightReturn(
  temp: t.Identifier,
  rightHelper: t.Identifier,
): t.IfStatement {
  const returnStatement = t.returnStatement(
    t.callExpression(t.cloneNode(rightHelper), [member(temp, 'value')]),
  )
  ;(
    returnStatement as t.ReturnStatement & { __yeetGenerated?: boolean }
  ).__yeetGenerated = true

  return t.ifStatement(isTag(temp, 'Right'), returnStatement)
}

function generatedErrorPush(
  temp: t.Identifier,
  errors: t.Identifier,
): t.IfStatement {
  return t.ifStatement(
    isTag(temp, 'Left'),
    t.blockStatement(errorPushStatements(temp, errors)),
  )
}

function errorPushStatements(
  temp: t.Identifier,
  errors: t.Identifier,
): t.Statement[] {
  return [
    t.ifStatement(
      t.binaryExpression('===', t.cloneNode(errors), t.identifier('undefined')),
      t.expressionStatement(
        t.assignmentExpression('=', t.cloneNode(errors), t.arrayExpression([])),
      ),
    ),
    t.expressionStatement(callPush(errors, member(temp, 'error'))),
  ]
}

function rightValueOrUndefined(temp: t.Identifier): t.ConditionalExpression {
  return t.conditionalExpression(
    isTag(temp, 'Right'),
    member(temp, 'value'),
    t.identifier('undefined'),
  )
}

function isTag(temp: t.Identifier, tag: 'Left' | 'Right'): t.BinaryExpression {
  return t.binaryExpression('===', member(temp, '_tag'), t.stringLiteral(tag))
}

function member(object: t.Identifier, property: string): t.MemberExpression {
  return t.memberExpression(t.cloneNode(object), t.identifier(property))
}

function callPush(array: t.Identifier, value: t.Expression): t.CallExpression {
  return t.callExpression(
    t.memberExpression(t.cloneNode(array), t.identifier('push')),
    [value],
  )
}

function finishWithErrors(
  ret: t.Expression,
  errors: t.Identifier,
  leftHelper: t.Identifier,
  rightHelper: t.Identifier,
): t.ConditionalExpression {
  return t.conditionalExpression(
    t.binaryExpression('===', t.cloneNode(errors), t.identifier('undefined')),
    t.callExpression(t.cloneNode(rightHelper), [ret]),
    t.callExpression(t.cloneNode(leftHelper), [t.cloneNode(errors)]),
  )
}

function rewriteEitherReturns(
  fnPath: NodePath<t.FunctionExpression>,
  rightHelper: t.Identifier,
): void {
  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    ReturnStatement(path: NodePath<t.ReturnStatement>) {
      if (
        (path.node as t.ReturnStatement & { __yeetGenerated?: boolean })
          .__yeetGenerated
      ) {
        return
      }

      const argument = path.node.argument
      if (argument === null || argument === undefined) {
        path.node.argument = t.callExpression(t.cloneNode(rightHelper), [
          t.identifier('undefined'),
        ])
        return
      }

      if (isDefinitelyNotLeft(argument)) {
        path.node.argument = t.callExpression(t.cloneNode(rightHelper), [
          argument,
        ])
        return
      }

      const ret = path.scope.generateUidIdentifier('yeetReturn')
      path.insertBefore(
        t.variableDeclaration('const', [
          t.variableDeclarator(t.cloneNode(ret), argument),
        ]),
      )
      path.node.argument = finishEitherReturn(t.cloneNode(ret), rightHelper)
    },
  })
}

function isDefinitelyNotLeft(node: t.Expression): boolean {
  const expression = skipTransparentExpressionNode(node)
  if (
    t.isNullLiteral(expression) ||
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isBigIntLiteral(expression) ||
    t.isTemplateLiteral(expression) ||
    t.isUnaryExpression(expression) ||
    t.isBinaryExpression(expression) ||
    t.isUpdateExpression(expression) ||
    t.isFunctionExpression(expression) ||
    t.isArrowFunctionExpression(expression) ||
    t.isClassExpression(expression)
  ) {
    return true
  }

  if (t.isConditionalExpression(expression)) {
    return (
      isDefinitelyNotLeft(expression.consequent) &&
      isDefinitelyNotLeft(expression.alternate)
    )
  }

  if (t.isSequenceExpression(expression)) {
    const last = expression.expressions.at(-1)
    return last !== undefined && isDefinitelyNotLeft(last)
  }

  return false
}

function rewriteFinalizingReturns(
  fnPath: NodePath<t.FunctionExpression>,
  finish: (ret: t.Expression) => t.Expression,
): void {
  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    ReturnStatement(path: NodePath<t.ReturnStatement>) {
      if (
        (path.node as t.ReturnStatement & { __yeetGenerated?: boolean })
          .__yeetGenerated
      ) {
        return
      }

      const argument = path.node.argument
      if (argument === null) {
        path.node.argument = finish(t.identifier('undefined'))
        return
      }

      const ret = path.scope.generateUidIdentifier('yeetReturn')
      path.insertBefore(
        t.variableDeclaration('const', [
          t.variableDeclarator(t.cloneNode(ret), argument),
        ]),
      )
      path.node.argument = finish(t.cloneNode(ret))
    },
  })
}

function rewriteCollectReturns(
  fnPath: NodePath<t.FunctionExpression>,
  errors: t.Identifier,
  values: t.Identifier,
): void {
  fnPath.traverse({
    Function(path: NodePath<t.Function>) {
      if (path !== fnPath) path.skip()
    },
    ReturnStatement(path: NodePath<t.ReturnStatement>) {
      const argument = path.node.argument
      if (argument === null || argument === undefined) {
        path.node.argument = collectedObject(errors, values)
        return
      }

      path.node.argument = t.sequenceExpression([
        argument,
        collectedObject(errors, values),
      ])
    },
  })
}

function collectedObject(
  errors: t.Identifier,
  values: t.Identifier,
): t.ObjectExpression {
  return t.objectExpression([
    t.objectProperty(t.identifier('errors'), t.cloneNode(errors)),
    t.objectProperty(t.identifier('values'), t.cloneNode(values)),
  ])
}

function appendFallthroughReturn(
  fnPath: NodePath<t.FunctionExpression>,
  rightHelper: t.Identifier,
): void {
  const last = fnPath.node.body.body.at(-1)
  if (t.isReturnStatement(last) || t.isThrowStatement(last)) return

  fnPath.node.body.body.push(
    t.returnStatement(
      t.callExpression(t.cloneNode(rightHelper), [t.identifier('undefined')]),
    ),
  )
}

function finishEitherReturn(
  ret: t.Identifier,
  rightHelper: t.Identifier,
): t.ConditionalExpression {
  return t.conditionalExpression(
    t.logicalExpression(
      '&&',
      t.logicalExpression(
        '&&',
        t.binaryExpression('!==', t.cloneNode(ret), t.nullLiteral()),
        t.binaryExpression(
          '===',
          t.unaryExpression('typeof', t.cloneNode(ret)),
          t.stringLiteral('object'),
        ),
      ),
      isTag(ret, 'Left'),
    ),
    t.cloneNode(ret),
    t.callExpression(t.cloneNode(rightHelper), [t.cloneNode(ret)]),
  )
}
