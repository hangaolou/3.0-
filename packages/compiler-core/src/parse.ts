import {
  ErrorCodes,
  CompilerError,
  createCompilerError,
  defaultOnError
} from './errors'
import {
  assert,
  advancePositionWithMutation,
  advancePositionWithClone
} from './utils'
import {
  Namespace,
  Namespaces,
  AttributeNode,
  CommentNode,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  Position,
  RootNode,
  SourceLocation,
  TextNode,
  TemplateChildNode,
  InterpolationNode
} from './ast'

export interface ParserOptions {
  isVoidTag?: (tag: string) => boolean // e.g. img, br, hr
  getNamespace?: (tag: string, parent: ElementNode | undefined) => Namespace
  getTextMode?: (tag: string, ns: Namespace) => TextModes
  delimiters?: [string, string] // ['{{', '}}']
  ignoreSpaces?: boolean

  // Map to HTML entities. E.g., `{ "amp;": "&" }`
  // The full set is https://html.spec.whatwg.org/multipage/named-characters.html#named-character-references
  namedCharacterReferences?: { [name: string]: string | undefined }

  onError?: (error: CompilerError) => void
}

export const defaultParserOptions: Required<ParserOptions> = {
  delimiters: [`{{`, `}}`],
  ignoreSpaces: true,
  getNamespace: () => Namespaces.HTML, //我理解这些值是ts中的枚举
  getTextMode: () => TextModes.DATA,
  isVoidTag: () => false,
  namedCharacterReferences: {
    'gt;': '>',
    'lt;': '<',
    'amp;': '&',
    'apos;': "'",
    'quot;': '"'
  },
  onError: defaultOnError
}

export const enum TextModes {
  //          | Elements | Entities | End sign              | Inside of
  DATA, //    | ✔       | ✔       | End tags of ancestors |
  RCDATA, //  | ✘       | ✔       | End tag of the parent | <textarea>
  RAWTEXT, // | ✘       | ✘       | End tag of the parent | <style>,<script>
  CDATA,
  ATTRIBUTE_VALUE
}

interface ParserContext {
  options: Required<ParserOptions>
  readonly originalSource: string
  source: string
  offset: number
  line: number
  column: number
  maxCRNameLength: number
}
//解析内容为字符串与options对象
export function parse(content: string, options: ParserOptions = {}): RootNode {
  //返回一个新对象，将content字符串，赋值为对象的元素：originalSource、source
  //新对象包含一些索引属性,以及defaultParserOptions对象与options对象合并为options

  const context = createParserContext(content, options)

  //返回一个索引索引用途的对象，包括三个属性 column、line、offset。

  const start = getCursor(context)
  //返回值为根节点RootNode
  return {
    type: NodeTypes.ROOT, // 60行出（定义） ，ts中的枚举，值 1
    children: parseChildren(context, TextModes.DATA, []),
    helpers: [],
    components: [],
    directives: [],
    hoists: [],
    codegenNode: undefined,
    //解析的字符串
    loc: getSelection(context, start)
  }
}

function createParserContext(
  content: string,
  options: ParserOptions
): ParserContext {
  return {
    options: {
      ...defaultParserOptions,
      ...options
    },
    column: 1, //列
    line: 1, //行
    offset: 0, //字符串的位置
    originalSource: content, //存储最初始的字符串
    source: content,
    //找出转义字符中最大的
    maxCRNameLength: Object.keys(
      options.namedCharacterReferences ||
        defaultParserOptions.namedCharacterReferences
    ).reduce((max, name) => Math.max(max, name.length), 0)
  }
}

function parseChildren(
  context: ParserContext,
  mode: TextModes, //0
  ancestors: ElementNode[]
): TemplateChildNode[] {
  //last()取数组的最后一项,无则undefine
  const parent = last(ancestors)
  //姑且理解为html的命名空间
  const ns = parent ? parent.ns : Namespaces.HTML
  //nodes 初始为[]
  const nodes: TemplateChildNode[] = []
  //初始化阶段，isEnd返值为false
  while (!isEnd(context, mode, ancestors)) {
    //字符串为空时，报错
    __DEV__ && assert(context.source.length > 0)

    const s = context.source
    let node: TemplateChildNode | TemplateChildNode[] | undefined = undefined

    // context.options.delimiters[0]  delimiters: [`{{`, `}}`],
    //10.28未读到
    if (startsWith(s, context.options.delimiters[0])) {
      // 取{{}}中的值的时候要走这里
      node = parseInterpolation(context, mode)
      //mode 初值1
    }
    //初始化是直接进入else分支
    else if (mode === TextModes.DATA && s[0] === '<') {
      // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
      if (s.length === 1) {
        emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 1)
      }
      //声明注释的那堆东西，后面在读
      else if (s[1] === '!') {
        // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
        if (startsWith(s, '<!--')) {
          node = parseComment(context)
        } else if (startsWith(s, '<!DOCTYPE')) {
          // Ignore DOCTYPE by a limitation.
          node = parseBogusComment(context)
        } else if (startsWith(s, '<![CDATA[')) {
          if (ns !== Namespaces.HTML) {
            node = parseCDATA(context, ancestors)
          } else {
            emitError(context, ErrorCodes.CDATA_IN_HTML_CONTENT)
            node = parseBogusComment(context)
          }
        } else {
          emitError(context, ErrorCodes.INCORRECTLY_OPENED_COMMENT)
          node = parseBogusComment(context)
        }
      } else if (s[1] === '/') {
        // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
        if (s.length === 2) {
          emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 2)
        } else if (s[2] === '>') {
          emitError(context, ErrorCodes.MISSING_END_TAG_NAME, 2)
          advanceBy(context, 3)
          continue
        } else if (/[a-z]/i.test(s[2])) {
          emitError(context, ErrorCodes.X_INVALID_END_TAG)
          parseTag(context, TagType.End, parent)
          continue
        } else {
          emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 2)
          node = parseBogusComment(context)
        }
      }
      //进入正常的标签，如<div>
      else if (/[a-z]/i.test(s[1])) {
        //正常的标签如<div>
        node = parseElement(context, ancestors)
      } else if (s[1] === '?') {
        emitError(
          context,
          ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
          1
        )
        node = parseBogusComment(context)
      } else {
        emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 1)
      }
    }
    if (!node) {
      node = parseText(context, mode)
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pushNode(context, nodes, node[i])
      }
    } else {
      pushNode(context, nodes, node)
    }
  }

  return nodes
}

function pushNode(
  context: ParserContext,
  nodes: TemplateChildNode[],
  node: TemplateChildNode
): void {
  // ignore comments in production
  /* istanbul ignore next */
  if (!__DEV__ && node.type === NodeTypes.COMMENT) {
    return
  }
  if (
    context.options.ignoreSpaces &&
    node.type === NodeTypes.TEXT &&
    node.isEmpty
  ) {
    return
  }

  // Merge if both this and the previous node are text and those are consecutive.
  // This happens on "a < b" or something like.
  const prev = last(nodes)
  if (
    prev &&
    prev.type === NodeTypes.TEXT &&
    node.type === NodeTypes.TEXT &&
    prev.loc.end.offset === node.loc.start.offset
  ) {
    prev.content += node.content
    prev.isEmpty = prev.content.trim().length === 0
    prev.loc.end = node.loc.end
    prev.loc.source += node.loc.source
  } else {
    nodes.push(node)
  }
}

function parseCDATA(
  context: ParserContext,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  __DEV__ &&
    assert(last(ancestors) == null || last(ancestors)!.ns !== Namespaces.HTML)
  __DEV__ && assert(startsWith(context.source, '<![CDATA['))

  advanceBy(context, 9)
  const nodes = parseChildren(context, TextModes.CDATA, ancestors)
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_CDATA)
  } else {
    __DEV__ && assert(startsWith(context.source, ']]>'))
    advanceBy(context, 3)
  }

  return nodes
}

function parseComment(context: ParserContext): CommentNode {
  __DEV__ && assert(startsWith(context.source, '<!--'))

  const start = getCursor(context)
  let content: string

  // Regular comment.
  const match = /--(\!)?>/.exec(context.source)
  if (!match) {
    content = context.source.slice(4)
    advanceBy(context, context.source.length)
    emitError(context, ErrorCodes.EOF_IN_COMMENT)
  } else {
    if (match.index <= 3) {
      emitError(context, ErrorCodes.ABRUPT_CLOSING_OF_EMPTY_COMMENT)
    }
    if (match[1]) {
      emitError(context, ErrorCodes.INCORRECTLY_CLOSED_COMMENT)
    }
    content = context.source.slice(4, match.index)

    // Advancing with reporting nested comments.
    const s = context.source.slice(0, match.index)
    let prevIndex = 1,
      nestedIndex = 0
    while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
      advanceBy(context, nestedIndex - prevIndex + 1)
      if (nestedIndex + 4 < s.length) {
        emitError(context, ErrorCodes.NESTED_COMMENT)
      }
      prevIndex = nestedIndex + 1
    }
    advanceBy(context, match.index + match[0].length - prevIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseBogusComment(context: ParserContext): CommentNode | undefined {
  __DEV__ && assert(/^<(?:[\!\?]|\/[^a-z>])/i.test(context.source))

  const start = getCursor(context)
  const contentStart = context.source[1] === '?' ? 1 : 2
  let content: string

  const closeIndex = context.source.indexOf('>')
  if (closeIndex === -1) {
    content = context.source.slice(contentStart)
    advanceBy(context, context.source.length)
  } else {
    content = context.source.slice(contentStart, closeIndex)
    advanceBy(context, closeIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseElement(
  context: ParserContext,
  ancestors: ElementNode[]
): ElementNode | undefined {
  __DEV__ && assert(/^<[a-z]/i.test(context.source))

  // Start tag.
  //初始化是，ancestors为空数组,应该为undifine
  const parent = last(ancestors)
  //TagType为ts枚举，值为0
  const element = parseTag(context, TagType.Start, parent)
  //用以判断字符串是否结束例如<div>没有结束。
  if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
    return element
  }

  // Children.
  ancestors.push(element)
  const mode = (context.options.getTextMode(
    element.tag,
    element.ns
  ) as unknown) as TextModes
  //递归在这里
  const children = parseChildren(context, mode, ancestors)
  ancestors.pop()

  element.children = children

  // End tag.
  if (startsWithEndTagOpen(context.source, element.tag)) {
    parseTag(context, TagType.End, parent)
  } else {
    emitError(context, ErrorCodes.X_MISSING_END_TAG)
    if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
      const first = children[0]
      if (first && startsWith(first.loc.source, '<!--')) {
        emitError(context, ErrorCodes.EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT)
      }
    }
  }

  element.loc = getSelection(context, element.loc.start)
  return element
}

const enum TagType {
  Start,
  End
}

/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 */
function parseTag(
  context: ParserContext,
  type: TagType,
  parent: ElementNode | undefined
): ElementNode {
  __DEV__ && assert(/^<\/?[a-z]/i.test(context.source))
  __DEV__ &&
    assert(
      type === (startsWith(context.source, '</') ? TagType.End : TagType.Start)
    )

  // Tag open.
  //返回对象，为行列偏移。 column: 1, line: 1,offset: 0,
  const start = getCursor(context)
  // \/转义为可选  ([a-z][^\t\r\n\f />]*)捕获内容，数组的第二项。如<div> 那么tag的值为"div"
  const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source)!
  const tag = match[1]
  const props = [] //用来存放特性对象。
  //命名空间么，目前还不理解。
  const ns = context.options.getNamespace(tag, parent)
  //用以选出标签类型，主要有 slot template component
  let tagType = ElementTypes.ELEMENT
  //slot标签单独处理。
  if (tag === 'slot') tagType = ElementTypes.SLOT
  else if (tag === 'template') tagType = ElementTypes.TEMPLATE
  else if (/[A-Z-]/.test(tag)) tagType = ElementTypes.COMPONENT
  //字符串剪切标签，如<div
  advanceBy(context, match[0].length)

  advanceSpaces(context)

  // Attributes.
  //Set 去重
  const attributeNames = new Set<string>()
  //处理标签中的特性。
  while (
    context.source.length > 0 &&
    !startsWith(context.source, '>') &&
    !startsWith(context.source, '/>')
  ) {
    if (startsWith(context.source, '/')) {
      emitError(context, ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG)
      advanceBy(context, 1)
      advanceSpaces(context)
      continue
    }
    if (type === TagType.End) {
      emitError(context, ErrorCodes.END_TAG_WITH_ATTRIBUTES)
    }

    const attr = parseAttribute(context, attributeNames)
    if (type === TagType.Start) {
      props.push(attr)
    }

    if (/^[^\t\r\n\f />]/.test(context.source)) {
      emitError(context, ErrorCodes.MISSING_WHITESPACE_BETWEEN_ATTRIBUTES)
    }
    advanceSpaces(context)
  }

  // Tag close.
  let isSelfClosing = false
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_TAG)
  } else {
    isSelfClosing = startsWith(context.source, '/>')
    if (type === TagType.End && isSelfClosing) {
      emitError(context, ErrorCodes.END_TAG_WITH_TRAILING_SOLIDUS)
    }
    advanceBy(context, isSelfClosing ? 2 : 1)
  }

  return {
    type: NodeTypes.ELEMENT,
    ns,
    tag,
    tagType,
    props,
    isSelfClosing,
    children: [],
    loc: getSelection(context, start),
    codegenNode: undefined // to be created during transform phase
  }
}

function parseAttribute(
  context: ParserContext,
  nameSet: Set<string>
): AttributeNode | DirectiveNode {
  __DEV__ && assert(/^[^\t\r\n\f />]/.test(context.source))

  // Name.
  //1,获取字符串的坐标
  const start = getCursor(context)
  //从头匹配,第一个匹配项为非空格或特殊字符（可以为＝），第二匹配连续字符不可以为等号。 match为数组！
  const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source)!
  //name的值假设为'@classs'
  const name = match[0]
  //nameSet为Set实例。
  if (nameSet.has(name)) {
    emitError(context, ErrorCodes.DUPLICATE_ATTRIBUTE)
  }
  //nameSet中添加name
  nameSet.add(name)
  //name 的第一个字符串值为'='，则报错。
  if (name[0] === '=') {
    emitError(context, ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME)
  }
  //用以检测name字符串中是否含有"'<，若有报错。
  {
    const pattern = /["'<]/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(name)) !== null) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        m.index
      )
    }
  }
  //更新context中的坐标，source中剪去name的值。
  advanceBy(context, name.length)

  // Value
  //定义value值，对象或undefined。
  let value:
    | {
        content: string
        isQuoted: boolean
        loc: SourceLocation
      }
    | undefined = undefined
  //这时context.source的值已剪切。
  //匹配，=之前可以有一个或多个空格或其他特殊字符。
  if (/^[\t\r\n\f ]*=/.test(context.source)) {
    //context.source剪切空格，更新坐标
    advanceSpaces(context)
    //context.source剪切等号，更新坐标。
    advanceBy(context, 1)
    advanceSpaces(context)
    //转入的值以"开头。
    value = parseAttributeValue(context)
    if (!value) {
      emitError(context, ErrorCodes.MISSING_ATTRIBUTE_VALUE)
    }
  }
  //返回的值包括name与value
  const loc = getSelection(context, start)
  // | 类似于或的概念
  if (/^(v-|:|@|#)/.test(name)) {
    // v-***(0-1), ((:|@ |#) ...)(0-1) ,  ...$  不是点的其它字符[^\.]
    const match = /(?:^v-([a-z0-9-]+))?(?:(?::|^@|^#)([^\.]+))?(.+)?$/i.exec(
      name
    )!

    let arg: ExpressionNode | undefined

    if (match[2]) {
      //@或#之前的字符串长度（包括）
      //尽量进入具体场景
      const startOffset = name.split(match[2], 2)!.shift()!.length

      //返回对象，包含开始坐标，结束坐标，以及开始结束之间的字段。
      const loc = getSelection(
        context,
        //返回新的字符串坐标的，将原先的坐标加上@前面的字符串。
        //取start与startOffset之间的字符串，更新start坐标。
        getNewPosition(context, start, startOffset),
        getNewPosition(context, start, startOffset + match[2].length)
      )
      //值为'class'
      let content = match[2]
      let isStatic = true

      if (content.startsWith('[')) {
        isStatic = false

        if (!content.endsWith(']')) {
          emitError(
            context,
            ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END
          )
        }
        content = content.substr(1, content.length - 2)
      }

      arg = {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content,
        isStatic,
        loc
      }
    }

    if (value && value.isQuoted) {
      const valueLoc = value.loc
      valueLoc.start.offset++
      valueLoc.start.column++
      valueLoc.end = advancePositionWithClone(valueLoc.start, value.content)
      valueLoc.source = valueLoc.source.slice(1, -1)
    }

    return {
      type: NodeTypes.DIRECTIVE,
      name:
        match[1] ||
        (startsWith(name, ':')
          ? 'bind'
          : startsWith(name, '@')
            ? 'on'
            : 'slot'),
      exp: value && {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content: value.content,
        isStatic: false,
        loc: value.loc
      },
      arg,
      modifiers: match[3] ? match[3].substr(1).split('.') : [],
      loc
    }
  }

  return {
    type: NodeTypes.ATTRIBUTE,
    name,
    value: value && {
      type: NodeTypes.TEXT,
      content: value.content,
      isEmpty: value.content.trim().length === 0,
      loc: value.loc
    },
    loc
  }
}
//说说这个函数干了个啥
//判断是否为引号，是则取出引号中间的值，生成对象，剪切引号中间的值包括引号，更新坐标。
//如不是引号，但为连续的字符，则取字符，返回对象，更新坐标

function parseAttributeValue(
  context: ParserContext //返回值
):
  | {
      content: string
      isQuoted: boolean
      loc: SourceLocation
    }
  | undefined {
  //取字符串坐标
  const start = getCursor(context)
  let content: string
  //取第一个字符串。
  const quote = context.source[0]
  // 为true则为引号。
  const isQuoted = quote === `"` || quote === `'`
  //引号则
  if (isQuoted) {
    // Quoted value.
    //原字符剪切左引号，更新坐标。
    advanceBy(context, 1)
    //取右引号。
    const endIndex = context.source.indexOf(quote)
    if (endIndex === -1) {
      content = parseTextData(
        context,
        context.source.length,
        TextModes.ATTRIBUTE_VALUE
      )
    } else {
      content = parseTextData(context, endIndex, TextModes.ATTRIBUTE_VALUE)
      //移出引号
      advanceBy(context, 1)
    }
  } else {
    // Unquoted
    const match = /^[^\t\r\n\f >]+/.exec(context.source)
    if (!match) {
      return undefined
    }
    let unexpectedChars = /["'<=`]/g
    let m: RegExpExecArray | null
    while ((m = unexpectedChars.exec(match[0])) !== null) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        m.index
      )
    }
    content = parseTextData(context, match[0].length, TextModes.ATTRIBUTE_VALUE)
  }
  //返回值包括左右引号。
  return { content, isQuoted, loc: getSelection(context, start) }
}
//解析差值 "{{}}"
function parseInterpolation(
  context: ParserContext,
  mode: TextModes
): InterpolationNode | undefined {
  const [open, close] = context.options.delimiters
  __DEV__ && assert(startsWith(context.source, open))
  //为查找的位置
  const closeIndex = context.source.indexOf(close, open.length)
  if (closeIndex === -1) {
    emitError(context, ErrorCodes.X_MISSING_INTERPOLATION_END)
    return undefined
  }
  //context的初始坐标
  const start = getCursor(context)
  advanceBy(context, open.length)
  const innerStart = getCursor(context)
  const innerEnd = getCursor(context)
  const rawContentLength = closeIndex - open.length
  const rawContent = context.source.slice(0, rawContentLength)
  const preTrimContent = parseTextData(context, rawContentLength, mode)
  const content = preTrimContent.trim()
  const startOffset = preTrimContent.indexOf(content)
  if (startOffset > 0) {
    advancePositionWithMutation(innerStart, rawContent, startOffset)
  }
  const endOffset =
    rawContentLength - (preTrimContent.length - content.length - startOffset)
  advancePositionWithMutation(innerEnd, rawContent, endOffset)
  advanceBy(context, close.length)

  return {
    type: NodeTypes.INTERPOLATION,
    content: {
      type: NodeTypes.SIMPLE_EXPRESSION,
      isStatic: false,
      content,
      loc: getSelection(context, innerStart, innerEnd)
    },
    loc: getSelection(context, start)
  }
}

function parseText(context: ParserContext, mode: TextModes): TextNode {
  __DEV__ && assert(context.source.length > 0)

  const [open] = context.options.delimiters
  const endIndex = Math.min(
    ...[
      context.source.indexOf('<', 1),
      context.source.indexOf(open, 1),
      mode === TextModes.CDATA ? context.source.indexOf(']]>') : -1,
      context.source.length
    ].filter(n => n !== -1)
  )
  __DEV__ && assert(endIndex > 0)

  const start = getCursor(context)
  const content = parseTextData(context, endIndex, mode)

  return {
    type: NodeTypes.TEXT,
    content,
    loc: getSelection(context, start),
    isEmpty: !content.trim()
  }
}

/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 */
/**
 * 如果引号之间不存在/&(?:#x?)?/且引号之间有值，则返回引号之间的值。
 * 若引号之间存在/&(?:#x?)?/，则读取转字符，尝试转义，转义成功复制text，继续循环。
 * 不成功将原值赋值给text，继续循环，直至引号的位置。
 *
 */
function parseTextData(
  context: ParserContext,
  length: number, //length指的是第二引号的值的索引
  mode: TextModes
): string {
  if (mode === TextModes.RAWTEXT || mode === TextModes.CDATA) {
    const text = context.source.slice(0, length)
    advanceBy(context, length)
    return text
  }

  // DATA or RCDATA. Entity decoding required.
  //到引号前的那个位置。
  const end = context.offset + length
  let text: string = ''
  //length的值为,如 class ="llll",中第二个引号的位置。
  //若length大于0，则
  while (context.offset < end) {
    //匹配&或者&#x（可选项）
    const head = /&(?:#x?)?/i.exec(context.source)
    //text,取到双引号之间的值
    //若无& 或 &位置在引号之外，则text为 "" 之间的值，跳出循环
    if (!head || context.offset + head.index >= end) {
      const remaining = end - context.offset
      text += context.source.slice(0, remaining)
      //更新坐标
      advanceBy(context, remaining)
      break
    }
    //假设 context.source 为 "*****&****"
    // Advance to the "&".移动到"&"这个位置.
    //head.index 为"&"第一次出现的位置。
    text += context.source.slice(0, head.index)
    advanceBy(context, head.index)
    //假设 context.source 为 "&****"
    //如果第一个值是'&',则
    if (head[0] === '&') {
      // Named character reference.
      let name = '',
        value: string | undefined = undefined
      //先假设context.source[0]为&
      if (/[0-9a-z]/i.test(context.source[1])) {
        //这个for循环就是找到转义字符对应的字符。这么简单但是晕啥。
        // for循环以length值逐步减小，取转义字符对应的值，赋为value。
        for (
          let length = context.maxCRNameLength;
          !value && length > 0;
          --length
        ) {
          //name 拿的是转义字符,也是&到引号之间的字符串。
          name = context.source.substr(1, length)
          value = context.options.namedCharacterReferences[name]
        }
        //假设 context.source 为 "&****"
        if (value) {
          const semi = name.endsWith(';')
          // 当context.source[1 + name.length] 值为 [=a-z0-9]
          if (
            mode === TextModes.ATTRIBUTE_VALUE &&
            !semi &&
            //判断name最后一个字符串的值
            /[=a-z0-9]/i.test(context.source[1 + name.length] || '')
          ) {
            //text 值为 *****
            text += '&'
            text += name // text 值为 *****&***
            //context 中的字符剪去转义字符。
            advanceBy(context, 1 + name.length) //context.source值为**...
          } else {
            text += value
            advanceBy(context, 1 + name.length)
            if (!semi) {
              emitError(
                context,
                ErrorCodes.MISSING_SEMICOLON_AFTER_CHARACTER_REFERENCE
              )
            }
          }
        } else {
          emitError(context, ErrorCodes.UNKNOWN_NAMED_CHARACTER_REFERENCE)
          text += '&'
          text += name
          advanceBy(context, 1 + name.length)
        }
      } else {
        text += '&'
        advanceBy(context, 1)
      }
    } else {
      // Numeric character reference.
      const hex = head[0] === '&#x'
      const pattern = hex ? /^&#x([0-9a-f]+);?/i : /^&#([0-9]+);?/
      const body = pattern.exec(context.source)
      if (!body) {
        text += head[0]
        emitError(
          context,
          ErrorCodes.ABSENCE_OF_DIGITS_IN_NUMERIC_CHARACTER_REFERENCE
        )
        advanceBy(context, head[0].length)
      }
      //这部分内容暂时不看
      else {
        //看下面的这个链接，暂不花费时间。
        // https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state
        let cp = Number.parseInt(body[1], hex ? 16 : 10)
        if (cp === 0) {
          emitError(context, ErrorCodes.NULL_CHARACTER_REFERENCE)
          cp = 0xfffd
        } else if (cp > 0x10ffff) {
          emitError(
            context,
            ErrorCodes.CHARACTER_REFERENCE_OUTSIDE_UNICODE_RANGE
          )
          cp = 0xfffd
        } else if (cp >= 0xd800 && cp <= 0xdfff) {
          emitError(context, ErrorCodes.SURROGATE_CHARACTER_REFERENCE)
          cp = 0xfffd
        } else if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) {
          emitError(context, ErrorCodes.NONCHARACTER_CHARACTER_REFERENCE)
        } else if (
          (cp >= 0x01 && cp <= 0x08) ||
          cp === 0x0b ||
          (cp >= 0x0d && cp <= 0x1f) ||
          (cp >= 0x7f && cp <= 0x9f)
        ) {
          emitError(context, ErrorCodes.CONTROL_CHARACTER_REFERENCE)
          cp = CCR_REPLACEMENTS[cp] || cp
        }
        text += String.fromCodePoint(cp)
        advanceBy(context, body[0].length)
        if (!body![0].endsWith(';')) {
          emitError(
            context,
            ErrorCodes.MISSING_SEMICOLON_AFTER_CHARACTER_REFERENCE
          )
        }
      }
    }
  }
  return text
}

function getCursor(context: ParserContext): Position {
  const { column, line, offset } = context
  return { column, line, offset }
}

function getSelection(
  context: ParserContext,
  start: Position,
  end?: Position
): SourceLocation {
  end = end || getCursor(context)
  return {
    start,
    end,
    //从原始字符串中取出特性的部分
    source: context.originalSource.slice(start.offset, end.offset)
  }
}

function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1]
}

function startsWith(source: string, searchString: string): boolean {
  return source.startsWith(searchString)
}

function advanceBy(context: ParserContext, numberOfCharacters: number): void {
  const { source } = context
  __DEV__ && assert(numberOfCharacters <= source.length)
  //更新行列以及行
  advancePositionWithMutation(context, source, numberOfCharacters)
  context.source = source.slice(numberOfCharacters)
}
//找空格
function advanceSpaces(context: ParserContext): void {
  const match = /^[\t\r\n\f ]+/.exec(context.source)
  if (match) {
    advanceBy(context, match[0].length)
  }
}

function getNewPosition(
  context: ParserContext,
  start: Position,
  numberOfCharacters: number
): Position {
  return advancePositionWithClone(
    start,
    //这里可能有坑
    context.originalSource.slice(start.offset, numberOfCharacters),
    numberOfCharacters
  )
}

function emitError(
  context: ParserContext,
  code: ErrorCodes,
  offset?: number
): void {
  const loc = getCursor(context)
  if (offset) {
    loc.offset += offset
    loc.column += offset
  }
  context.options.onError(
    createCompilerError(code, {
      start: loc,
      end: loc,
      source: ''
    })
  )
}

function isEnd(
  context: ParserContext,
  mode: TextModes, //初始时传入的值为0
  ancestors: ElementNode[] //初始化是传入的是空数组
): boolean {
  //初始传入的字符串
  const s = context.source
  //mode值为1
  switch (mode) {
    case TextModes.DATA:
      // startsWith()判断字符串是否以字符串开头，可以选position。
      if (startsWith(s, '</')) {
        //TODO: probably bad performance
        for (let i = ancestors.length - 1; i >= 0; --i) {
          if (startsWithEndTagOpen(s, ancestors[i].tag)) {
            return true
          }
        }
      }
      break

    case TextModes.RCDATA:
    case TextModes.RAWTEXT: {
      const parent = last(ancestors)
      if (parent && startsWithEndTagOpen(s, parent.tag)) {
        return true
      }
      break
    }

    case TextModes.CDATA:
      if (startsWith(s, ']]>')) {
        return true
      }
      break
  }
  //初始化时，返回false
  return !s
}

function startsWithEndTagOpen(source: string, tag: string): boolean {
  //判断是否以'</'开始，判断tag是否相等，判断tag最后一项是否为/[\t\n\f />]/
  // \n:换行符、\t制表符、\f换页符
  return (
    startsWith(source, '</') &&
    source.substr(2, tag.length).toLowerCase() === tag.toLowerCase() &&
    /[\t\n\f />]/.test(source[2 + tag.length] || '>')
  )
}

// https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state
const CCR_REPLACEMENTS: { [key: number]: number | undefined } = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178
}
