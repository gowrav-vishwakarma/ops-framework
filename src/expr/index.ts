export { ExpressionError, parseExpression, expressionNames, type Ast } from './parse.js';
export { compileExpression, defineExpressionFunction, evaluate, expressionFunctions, isTrue, type CompiledExpression, type ExpressionFunction, type ExpressionScope } from './evaluate.js';
