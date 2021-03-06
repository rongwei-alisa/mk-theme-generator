const fs = require("fs");
const path = require("path");
const glob = require("glob");
const postcss = require("postcss");
const less = require("less");
const bundle = require("less-bundle-promise");
const hash = require("hash.js");
const NpmImportPlugin = require('less-plugin-npm-import');
const lessToJs = require('less-vars-to-js');

let hashCache = "";
let cssCache = "";
let colorVars = {};
let onlyRemainMainColor;

function randomColor() {
  return '#' + (Math.random() * 0xFFFFFF << 0).toString(16);
}

/*
  Recursively get the color code assigned to a variable e.g.
  @primary-color: #1890ff;
  @link-color: @primary-color;
 
  @link-color -> @primary-color ->  #1890ff
  Which means
  @link-color: #1890ff
*/
function getColor(varName, mappings) {
  const color = mappings[varName];
  if (color in mappings) {
    return getColor(color, mappings);
  } else {
    return color;
  }
}
/*
  Read following files and generate color variables and color codes mapping
    - Ant design color.less, themes/default.less
    - Your own variables.less
  It will generate map like this
  {
    '@primary-color': '#00375B',
    '@info-color': '#1890ff',
    '@success-color': '#52c41a',
    '@error-color': '#f5222d',
    '@normal-color': '#d9d9d9',
    '@primary-6': '#1890ff',
    '@heading-color': '#fa8c16',
    '@text-color': '#ccc',
    ....
  }
*/
function generateColorMap(content) {
  return content
    .split("\n")
    .filter(line => line.startsWith("@") && line.indexOf(":") > -1)
    .reduce((prev, next) => {
      try {
        const matches = next.match(
          /(?=\S*['-])([@a-zA-Z0-9'-]+).*:[ ]{1,}(.*);/
        );
        if (!matches) {
          return prev;
        }
        let [, varName, color] = matches;
        if (color && color.startsWith("@")) {
          color = getColor(color, prev);
          if (!isValidColor(color)) return prev;
          prev[varName] = color;
        } else if (isValidColor(color)) {
          prev[varName] = color;
        }
        return prev;
      } catch (e) {
        console.log("e", e);
        return prev;
      }
    }, {});
}

const isContainColor = function (str, prop) {
  const matchResult = str.match(/#[0-9a-fA-F]{8}/) ||
    str.match(/#[0-9a-fA-F]{6}/) ||
    str.match(/#[0-9a-fA-F]{3,4}/);
  if (!matchResult) return prop.includes("background-size");
  const [color] = matchResult;
  const colors = Object.values(colorVars) || [];
  if (colors.includes(color)) {
    return true;
  } else {
    return false;
  }
}

/*
 This plugin will remove all css rules except those are related to colors
 e.g.
 Input: 
 .body { 
    font-family: 'Lato';
    background: #ccc;
    color: #000;
    padding: 0;
    pargin: 0
 }

 Output: 
  .body {
    background: #ccc;
    color: #000;
 }
*/
const reducePlugin = postcss.plugin("reducePlugin", () => {
  const cleanRule = rule => {
    if (rule.selector.startsWith(".main-color .palatte-")) {
      rule.remove();
      return;
    }
    let removeRule = true;
    rule.walkDecls(decl => {
      if (onlyRemainMainColor) {
        if (!isContainColor(decl.value, decl.prop)) {
          decl.remove();
        } else {
          removeRule = false;
        }
      } else {
        if (
          !decl.prop.includes("color") &&
          !decl.prop.includes("background") &&
          !decl.prop.includes("border") &&
          !decl.prop.includes("box-shadow") ||
          (decl.prop.includes("background") && !decl.value.includes('#'))
        ) {
          decl.remove();
        } else {
          removeRule = false;
        }
      }
    });
    if (removeRule) {
      rule.remove();
    }
  };
  return css => {
    // NOTE: ????????? ???????????? ??? ??????keyframe ?????????????????????????????????
    // css.walkAtRules(atRule => {
    //   atRule.remove();
    // });

    css.walkRules(cleanRule);

    css.walkComments(c => c.remove());
  };
});

function getMatches(string, regex) {
  const matches = {};
  let match;
  while ((match = regex.exec(string))) {
    if (match[2].startsWith("rgba") || match[2].startsWith("#")) {
      matches[`@${match[1]}`] = match[2];
    }
  }
  return matches;
}

/*
  This function takes less input as string and compiles into css.
*/
function render(text, paths) {
  return less.render.call(less, text, {
    paths: paths,
    javascriptEnabled: true,
    plugins: [new NpmImportPlugin({ prefix: '~' })]
  });
}

/*
  This funtion reads a less file and create an object with keys as variable names 
  and values as variables respective values. e.g.
  //variabables.less
    @primary-color : #1890ff;
    @heading-color : #fa8c16;
    @text-color : #ccc;
  
    to

    {
      '@primary-color' : '#1890ff',
      '@heading-color' : '#fa8c16',
      '@text-color' : '#ccc'
    }

*/
function getLessVars(filtPath) {
  const sheet = fs.readFileSync(filtPath).toString();
  const lessVars = {};
  const matches = sheet.match(/@(.*:[^;]*)/g) || [];

  matches.forEach(variable => {
    const definition = variable.split(/:\s*/);
    const varName = definition[0].replace(/['"]+/g, "").trim();
    lessVars[varName] = definition.splice(1).join(":");
  });
  return lessVars;
}

/*
  This function take primary color palette name and returns @primary-color dependent value
  .e.g 
  Input: @primary-1
  Output: color(~`colorPalette("@{primary-color}", ' 1 ')`)
*/
function getShade(varName) {
  let [, className, number] = varName.match(/(.*)-(\d)/);
  if (/^@primary-\d/.test(varName)) className = '@primary-color';
  return 'color(~`colorPalette("@{' + className.replace('@', '') + '}", ' + number + ")`)";
}

/*
  This function takes color string as input and return true if string is a valid color otherwise returns false.
  e.g.
  isValidColor('#ffffff'); //true
  isValidColor('#fff'); //true 
  isValidColor('rgba(0, 0, 0, 0.5)'); //true
  isValidColor('20px'); //false
*/
function isValidColor(color) {
  if (!color || color.match(/px/g)) return false;
  if (color.match(/colorPalette|fade/g)) return true;
  if (color.charAt(0) === "#") {
    color = color.substring(1);
    return (
      [3, 4, 6, 8].indexOf(color.length) > -1 && !isNaN(parseInt(color, 16))
    );
  }
  return /^(rgb|hsl|hsv)a?\((\d+%?(deg|rad|grad|turn)?[,\s]+){2,3}[\s\/]*[\d\.]+%?\)$/i.test(
    color
  );
}

function getClassNames(name) {
  return name;
}

function getCssModulesStyles(stylesDir, antdStylesDir, { generateScopedName, srcAlias = '@', resolvePath = 'src/' }) {
  const styles = glob.sync(path.join(stylesDir, './**/*.less'));
  return Promise.all(
    styles.map(p => {
      let str = fs.readFileSync(p).toString();
      let reg = new RegExp(`\@import +("|')~(${srcAlias})\/`, 'g');
      // NOTE modify: ??? less ???????????? ???root ????????? src ??????
      str = str.replace(reg, `@import $1${process.cwd()}/${resolvePath}`);
      return less
        .render(str, {
          paths: [
            stylesDir,
            antdStylesDir,
          ],
          filename: path.resolve(p),
          javascriptEnabled: true,
          plugins: [new NpmImportPlugin({ prefix: '~' })],
        })
        .catch((error) => {
          // console.log(error);
          return '\n'
        })
    })
  )
    // NOTE modify: ????????? css module ?????????
    .then(csss => {
      return Promise.all(
        csss.map((css, index) => {
          if (typeof css === 'string') {
            return new Promise(resolve => resolve('\n'));
          }
          return postcss([require("postcss-modules")({
            generateScopedName: generateScopedName || getClassNames,
          })]).process(css.css, {
            parser: less.parser,
            from: styles[index],
          })
        })
      )
    })
    .then(csss => {
      return csss.map(c => {
        return c.css
      }).join('\n')
    })
    .catch(err => {
      console.log('Error', err);
      return '';
    });
}

/*
  This is main function which call all other functions to generate color.less file which contins all color
  related css rules based on Ant Design styles and your own custom styles
  By default color.less will be generated in /public directory
*/
function generateTheme({
  antdStylesDir,
  businessStylesDir, // NOTE modify: ?????????????????????????????????
  stylesDir,
  varFile,
  outputFilePath,
  srcAlias,
  resolvePath,
  generateScopedName, // NOTE modify: ????????????????????? css ??????
  pureLess, // ???????????????????????????????????? less ?????????
}) {
  return new Promise((resolve, reject) => {
    onlyRemainMainColor = pureLess;
    /*
      Ant Design Specific Files (Change according to your project structure)
      You can even use different less based css framework and create color.less for  that
    
      - entry - Ant Design less main file / entry file
      - styles - Ant Design less styles for each component
    */
    const entry = path.join(antdStylesDir, './style/index.less');
    const styles = glob.sync(path.join(antdStylesDir, './*/style/index.less'));

    /*
      Maycur Business Specific Files (Change according to your project structure)
      You can even use different less based css framework and create color.less for  that
    
      - businessStylesDir - Maycur Business instalation path
      - businessEntry - Maycur Business less main file / entry file
      - businessStyles - Maycur Business less styles for each component
    */
    let businessStyles = [];
    if (businessStylesDir) {
      businessStyles = glob.sync(path.join(businessStylesDir, './**/style/*.less'));
    }

    /*
      You own custom styles (Change according to your project structure)
      
      - stylesDir - styles directory containing all less files 
      - varFile - variable file containing ant design specific and your own custom variables
    */
    varFile = varFile || path.join(antdStylesDir, "./style/themes/default.less");

    const paletteLess = fs.readFileSync(varFile, 'utf8');
    const variables = lessToJs(paletteLess);

    let content = fs.readFileSync(entry).toString();
    content += "\n";
    styles.concat(businessStyles).forEach(style => {
      content += `@import "${style}";\n`;
    });
    const hashCode = hash.sha256().update(content).digest('hex');
    if (hashCode === hashCache) {
      resolve(cssCache);
      return;
    }
    hashCache = hashCode;
    let themeCompiledVars = {};
    let themeVars = Object.keys(variables) || ["@primary-color"];
    const lessPaths = [
      path.join(antdStylesDir, "./style"),
      stylesDir,
    ];
    if (businessStylesDir) {
      lessPaths.push(path.join(businessStylesDir, "./style"));
    }

    return bundle({
      src: varFile
    })
      .then(colorsLess => {
        const mappings = generateColorMap(colorsLess);
        return [mappings, colorsLess];
      })
      .then(([mappings, colorsLess]) => {
        let css = "";
        themeVars = themeVars.filter(name => name in mappings);
        themeVars.forEach(varName => {
          const color = mappings[varName];
          css = `.${varName.replace("@", "")} { color: ${color}; }\n ${css}`;
        });

        // NOTE modify: antd-mobile ???????????? colorPalette ??????
        themeVars.forEach(varName => {
          [1, 2, 3, 4, 5, 7].forEach(key => {
            let name = varName === '@primary-color' ? `@primary-${key}` : `${varName}-${key}`;
            css = `.${name.replace("@", "")} { color: ${getShade(name)}; }\n ${css}`;
          });
        });

        css = `${colorsLess}\n${css}`;
        return render(css, lessPaths).then(({ css }) => [
          css,
          mappings,
          colorsLess
        ]);
      })
      .then(([css, mappings, colorsLess]) => {
        css = css.replace(/(\/.*\/)/g, "");
        const regex = /.(?=\S*['-])([.a-zA-Z0-9'-]+)\ {\n\ \ color:\ (.*);/g;
        themeCompiledVars = getMatches(css, regex);
        colorVars = themeCompiledVars;
        content = `${content}\n${colorsLess}`;
        return render(content, lessPaths).then(({ css }) => {
          return getCssModulesStyles(stylesDir, antdStylesDir, { generateScopedName, srcAlias, resolvePath })
            .then(customCss => [
              `${customCss}\n${css}`,
              mappings,
              colorsLess
            ])
        });
      })
      .then(([css, mappings, colorsLess]) => {
        return postcss([reducePlugin])
          .process(css, {
            parser: less.parser,
            from: entry
          })
          .then(({ css }) => [css, mappings, colorsLess]);
      })
      .then(([css, mappings, colorsLess]) => {
        Object.keys(themeCompiledVars).forEach(varName => {
          let color;
          if (/(.*)-(\d)/.test(varName)) {
            color = themeCompiledVars[varName];
            varName = getShade(varName);
          } else {
            color = themeCompiledVars[varName];
          }
          color = color.replace('(', '\\(').replace(')', '\\)');
          css = css.replace(new RegExp(`${color}`, "g"), varName);
        });

        css = `${colorsLess}\n${css}`;

        themeVars.reverse().forEach(varName => {
          css = css.replace(new RegExp(`${varName}(\ *):(.*);`, 'g'), '');
          css = `${varName}: ${mappings[varName]};\n${css}\n`;
        });
        if (outputFilePath) {
          fs.writeFileSync(outputFilePath, css);
          console.log(
            `Theme generated successfully. OutputFile: ${outputFilePath}`
          );
        } else {
          console.log(`Theme generated successfully`);
        }
        cssCache = css;
        return resolve(css);
      })
      .catch(err => {
        console.log("Error", err);
        reject(err);
      });
  });
}

module.exports = {
  generateTheme,
  isValidColor,
  getLessVars,
  randomColor,
  renderLessContent: render
};
