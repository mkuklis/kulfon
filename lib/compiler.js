// Copyright 2016 Zaiste & contributors. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const Promise = require('bluebird');
const sass = Promise.promisifyAll(require('node-sass'));

const nunjucks = require('nunjucks');
const markdown = require('nunjucks-markdown');
const marked = require('marked');
const fs = Promise.promisifyAll(require("fs-extra"));
const path = require('path');
const yaml = require('js-yaml');
const rollup = require('rollup').rollup;
const uglify = require('rollup-plugin-uglify');
const minify = require('uglify-js').minify;
const sha1 = require('sha1');
const matter = require('gray-matter');

const currentDirectory = process.cwd();
const dataPath = path.join(currentDirectory, 'website', 'data');

function isObject(item) {
  return (item && typeof item === 'object' && !Array.isArray(item) && item !== null);
}

function merge(target, source) {
  if (isObject(target) && isObject(source)) {
    for (let key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        merge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }
  return target;
}

function scan(directory, recursive = true) {
  return fs.readdirAsync(directory)
    .map(el => fs.statAsync(path.join(directory, el))
      .then(stat => {
        if (stat.isFile()) {
          return el;
        } else {
          return !recursive ? [] : scan(path.join(directory, el))
            .reduce((acc, _) => acc.concat(_), [])
            .map(_ => path.join(el, _));
        }
      })
    )
    .reduce((acc, _) => acc.concat(_), []);
}

let cache;

function __public(filename, inside = '') {
  return path.join(currentDirectory, 'public', inside, filename);
}

function __current(f = '') {
  return path.join(currentDirectory, 'website', f);
}

function compile(files) {
  const ENV = process.env.KULFON_ENV;

  const config = yaml.safeLoad(fs.readFileSync(path.join(currentDirectory, 'config.yml'), 'utf8'));

  const { stylesheets, javascripts, includePaths } = config;

  Promise.resolve().then(() => {
    return fs.statAsync(dataPath)
      .then(stats => stats.isDirectory())
      .catch(err => false);         // not directory, so parse `data.yml`
  }).then(isDirectory => {
    return isDirectory ?
      { content: fs.readdirAsync(dataPath), path: dataPath} :
      { content: ['data.yml'], path: path.join(currentDirectory, 'website') };
  }).then(directory => {
    return {
      files: directory.content.filter(f => fs.statSync(path.join(directory.path, f)).isFile()),
      path: directory.path
    }
  }).then(yml => {
    const content = yml.files
      .reduce((acc, _) =>
        [acc, fs.readFileSync(path.join(yml.path, _), 'utf8')].join('---\n'),
        '');

    let data = {};
    yaml.safeLoadAll(content, doc => {
      data = merge(data, doc);
    });

    // XXX ugly, execution order!
    let javascriptBundleFingerprint;

    for (let f of files) {
      let startTime = new Date();
      process.stdout.write(`${startTime.toISOString().grey} - Compiling ${f.yellow}... `);

      let output;
      let filename;

      switch (path.extname(f)) {
        // TODO optimize images
        case '.jpg':
        case '.png':
        case '.jpeg':
        case '.svg':
          fs.copyAsync(__current(f), __public(f))
          break;
        case ".html":
        case ".md":
          const env = nunjucks.configure('website', { autoescape: true });
          markdown.register(env, marked);

          const m = matter.read(__current(f));
          data = merge(data, m.data);

          output = nunjucks.renderString(m.content, {
            data,
            javascripts,
            stylesheets,
            javascriptBundleFingerprint,
          });

          // remove `pages` segment from the path
          f = f.split(path.sep).slice(1).join(path.sep);
          const { name, dir } = path.parse(f);

          // detect if date in the `name`
          // XXX ugly
          const segments = name.split('_');
          let d = Date.parse(segments[0]);

          if (d) {
            d = new Date(d);

            const year = String(d.getFullYear());
            const month = ("0" + (d.getMonth() + 1)).slice(-2)
            const day = String(d.getDate());
            const rest = segments.slice(1).join('_');

            filename = path.join(dir, year, month, rest);
          } else {
            filename = path.join(dir, name);
          }

          if (filename === 'index') {
            fs.outputFileSync(__public('index.html'), output)
          } else {
            fs.outputFileSync(__public('index.html', filename), output)
          }

          break;
        case ".sass":
        case ".scss":
          let filePath = __current(f);

          sass.renderAsync({
            file: filePath,
            includePaths: includePaths || [],
            outputStyle: 'compressed',
            sourceMap: true,
            outFile: __public('styles.css')
          }).then(result => {
            output = result.css;
            filename = `${path.basename(f, path.extname(f))}.css`

            fs.writeFileSync(__public(filename), output)
          }).catch(_ => console.log(_.formatted));

          break;
        case '.js':
          const dependencies = (javascripts || [])
            .map(name => name.split('/')[3].split('@')[0])
            .reduce((acc, name) => Object.assign(acc, { [name]: name }), {});

          const options = {
            entry: path.join(currentDirectory, 'website/javascripts', 'main.js'),
            cache: cache,
            external: Object.keys(dependencies),
          }

          if (ENV === 'production') {
            Object.assign(options, { plugins: [ uglify({}, minify) ] })
          }

          rollup(options)
            .then(bundle => {
              cache = bundle;

              if (ENV === 'production') {
                // XXX Ugly, only for `main.js`
                javascriptBundleFingerprint = sha1(bundle.modules[0].code);
              }

              const options = {
                format: 'iife',
                dest: __public(ENV === 'production' ? `bundle.${javascriptBundleFingerprint}.js` : 'bundle.js'),
              }

              return bundle.write(options);
            })
            .catch(_ => console.log(_.message));
          break;
      }

      let endTime = new Date();
      console.log(`${'done'.green} in ${endTime - startTime}ms`);
    }

    return true;
  })
  .catch(_ => {
    console.log(_.message)
    process.exit();
  });
}

function transformViews() {
  const prefix = 'pages';

  return scan(path.join('website', prefix))
    .map(f => path.join(prefix, f))
    .then(compile)
    .catch(_ => console.error(_.message));
}

function transformStylesheets() {
  const prefix = 'stylesheets';

  return scan(path.join('website', prefix))
    .filter(f => f[0] !== '_')
    .map(f => path.join(prefix, f))
    .then(compile)
    .catch(_ => console.error(_.message));
}

function transformJavascripts() {
  const prefix = 'javascripts';

  return scan(path.join('website', prefix))
    .map(f => path.join(prefix, f))
    .then(compile)
    .catch(_ => console.error(_.message));
}

function transformImages() {
  const prefix = 'images';

  return scan(path.join('website', prefix))
    .filter(f => ['.jpg', '.png', '.jpeg', '.svg'].includes(path.extname(f)))
    .map(f => path.join(prefix, f))
    .then(compile)
    .catch(_ => console.error(_.message));
}

function compileAll({ dir, env }) {
  return Promise
    .resolve([ 'website' ])
    .map(_ => fs.statSync(path.join(dir, _)))
    .then(() => fs.ensureDirAsync('public/images'))
    .then(transformStylesheets)
    .then(transformImages)
    .then(transformJavascripts)
    .then(transformViews)
    .catch(err => {
      console.log('Error: '.red + "it seems you are not in `kulfon` compatible directory");
      process.exit();
    })
}

module.exports = {
  compile,
  transformViews,
  compileAll,
  handler: compileAll,
  builder: _ => _
    .option('environment', { alias: ['e', 'env'], default: 'dev' })
    .default('dir', '.'),
};
