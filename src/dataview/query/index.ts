/**
 * Barrel for the Dataview query engine (B2: expression engine + DQL).
 * Public surface required by the task spec:
 *   ExpressionError, evaluateExpression, DvFunctions, DqlError, parseDql,
 *   executeDql — plus the golden neighbors (source/dataArray/datetime).
 */
export {ExpressionError, evaluateExpression, parseExpression, evalExpr} from "./expression";
export {DvFunctions} from "./functions";
export {DqlError, parseDql, rewriteSourceExpr, splitTopLevel} from "./parseDql";
export {executeDql} from "./executeDql";
export {matchSource} from "./source";
export {createDataArray, compareValues} from "./dataArray";
export {parseDate, parseDuration, now, today} from "./datetime";
export {truthy, looseEquals, toArrayOrNull} from "./semantics";
