import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

const UNITFUL_TOKENS = [
  "energy",
  "power",
  "price",
  "cost",
  "tariff",
  "feed in",
  "feedin",
  "import",
  "export",
  "savings",
  "duration",
] as const;

const TARGET_OPERATORS = new Set(["+", "-", "*", "/", "<", ">", "<=", ">="]);
const TARGET_ASSIGNMENT_OPERATORS = new Set(["+=", "-=", "*=", "/="]);

type Options = [];
type MessageIds = "noRawUnitArithmetic";

const createRule = ESLintUtils.RuleCreator((name) => name);

function normalizeName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/[^a-zA-Z ]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isUnitfulName(name: string): boolean {
  if (name === name.toUpperCase()) {
    return false;
  }
  const normalized = normalizeName(name);
  if (normalized.includes("threshold") || normalized.includes("epsilon")) {
    return false;
  }
  return UNITFUL_TOKENS.some((token) => normalized.includes(token));
}

function getExpressionName(node: TSESTree.Node | null | undefined): string | null {
  if (!node) {
    return null;
  }
  switch (node.type) {
    case "Identifier":
      return node.name;
    case "MemberExpression":
      if (!node.computed && node.property.type === "Identifier") {
        return node.property.name;
      }
      if (node.property.type === "Literal" && typeof node.property.value === "string") {
        return node.property.value;
      }
      return null;
    case "ChainExpression":
      return getExpressionName(node.expression);
    case "TSAsExpression":
    case "TSTypeAssertion":
      return getExpressionName(node.expression);
    case "UnaryExpression":
      return getExpressionName(node.argument);
    default:
      return null;
  }
}

function isPlainNumberExpression(
  node: TSESTree.Node,
  context: Readonly<Parameters<ReturnType<typeof createRule<Options, MessageIds>>["create"]>[0]>,
): boolean {
  const parserServices = ESLintUtils.getParserServices(context);
  const checker = parserServices.program.getTypeChecker();
  const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node);
  const type = checker.getTypeAtLocation(tsNode);
  const baseType = checker.getBaseTypeOfLiteralType(type);
  return checker.typeToString(baseType) === "number";
}

function findRawUnitfulOperand(
  node: TSESTree.Node,
  context: Readonly<Parameters<ReturnType<typeof createRule<Options, MessageIds>>["create"]>[0]>,
): { name: string; node: TSESTree.Node } | null {
  const name = getExpressionName(node);
  if (!name || !isUnitfulName(name)) {
    return null;
  }
  if (!isPlainNumberExpression(node, context)) {
    return null;
  }
  return {name, node};
}

const noRawUnitArithmeticRule = createRule<Options, MessageIds>({
  name: "no-raw-unit-arithmetic",
  meta: {
    type: "problem",
    docs: {
      description: "Disallow raw numeric arithmetic on unit-bearing internal variables",
    },
    schema: [],
    messages: {
      noRawUnitArithmetic:
        'Use domain objects instead of raw number arithmetic for unit-bearing "{{name}}" calculations.',
    },
  },
  defaultOptions: [],
  create(context) {
    function reportIfNeeded(operand: TSESTree.Node): void {
      const match = findRawUnitfulOperand(operand, context);
      if (!match) {
        return;
      }
      context.report({
        node: match.node,
        messageId: "noRawUnitArithmetic",
        data: {name: match.name},
      });
    }

    return {
      BinaryExpression(node: TSESTree.BinaryExpression) {
        if (!TARGET_OPERATORS.has(node.operator)) {
          return;
        }
        reportIfNeeded(node.left);
        reportIfNeeded(node.right);
      },
      AssignmentExpression(node: TSESTree.AssignmentExpression) {
        if (!TARGET_ASSIGNMENT_OPERATORS.has(node.operator)) {
          return;
        }
        reportIfNeeded(node.left);
        reportIfNeeded(node.right);
      },
    };
  },
});

export default noRawUnitArithmeticRule;
