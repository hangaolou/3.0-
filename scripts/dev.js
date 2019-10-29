/*
Run Rollup in watch mode for development.

To specific the package to watch, simply pass its name and the desired build
formats to watch (defaults to "global"):

```
# name supports fuzzy match. will watch all packages with name containing "dom"
yarn dev dom

# specify the format to output
yarn dev core --formats cjs

# Can also drop all __DEV__ blocks with:
__DEV__=false yarn dev
```
*/

const execa = require('execa')
const { targets, fuzzyMatchTarget } = require('./utils')
//把文件后面的参数解析成对象例如：$ node test.js --hello=world
const args = require('minimist')(process.argv.slice(2))
//args._.为字符串 fuzzyMatchTarget 返回一个数组为 packages下的子目录与args._中的元素匹配
const target = args._.length ? fuzzyMatchTarget(args._)[0] : 'vue'
const formats = args.formats || args.f
const commit = execa.sync('git', ['rev-parse', 'HEAD']).stdout.slice(0, 7)

execa(
  'rollup',
  [
    '-wc',
    '--environment',
    [
      `COMMIT:${commit}`,
      `TARGET:${target}`,
      `FORMATS:${formats || 'global'}`
    ].join(',')
  ],
  {
    stdio: 'inherit'
  }
)
