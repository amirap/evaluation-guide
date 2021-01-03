// Note: This is work-in-progress and not ready to be used

const url = require('url');
const path = require('path');
const fs = require('fs');
const shell = require('shelljs');
const _ = require('lodash');
const gutil = require('gulp-util');
const cheerio = require('cheerio');
const Promise = require('bluebird');
const helpers = require('./helpers');
const moment = require('moment');
const RSS = require('rss');
const { normalizeSafe } = require('upath');
const os = require('os');

const verbose = false;
const indicator = gutil.colors.cyan("[HTML CHECK]");
const feedindicator = gutil.colors.cyan("[FEED]");

let totalChecks = 0;
let totalChecked = 0;
let totalValidated = 0;
let lastParsed = 0;
let lastValidated = 0;
let allFiles = [];
let allResidualFiles = [];

const statistics = {
  image: [],
  video: [],
  youtube: [],
  iframe_unknown: []
};

const addStatistic = (key, value) => {
  if (typeof statistics[key] === 'undefined') {
    return;
  }
  if (statistics[key].indexOf(value) === -1) {
    statistics[key].push(value);
  }
};

let SOURCEPATH = null,
    EXTERNAL = false,
    DELETE_UNUSED_IMAGES = false;

const parseHtmlFile = file => new Promise((resolve, reject) => {

  file.basePath = file.path.replace(SOURCEPATH, '');

  if (file.content) {
    const $ = cheerio.load(file.content);

    // remove obsolete stuff
    $('pre, code').remove();

    $('img').each((i, el) => {
      const src = $(el).attr('src'),
            parsed = url.parse(src);

      if (parsed.hostname) {
        file.external.images.push(src);
      } else {
        if (parsed.query) {
          file.warnings.push(`${gutil.colors.yellow('[QS]     ')} The src of the image ${gutil.colors.cyan(src)} has a query string. Is that necessary?`);
        }

        if (src.indexOf('/') === 0) {
          file.images.push(src);
          addStatistic('image', src);
        } else {
          file.images.push(path.join(path.dirname(file.basePath), parsed.path));
          addStatistic('image', path.join(path.dirname(file.basePath), parsed.path));
        }
      }
    });

    $('video').each((i, el) => {
      const src = $(el).attr('src');

      if (!src) {
        file.warnings.push(`${gutil.colors.yellow('[VIDEO] ')} this file contains a video that has no src. Check the video`);
        return;
      }
      const parsed = url.parse(src);

      if (parsed.hostname) {
        file.external.videos.push(src);
      } else {
        if (parsed.query) {
          file.warnings.push(`${gutil.colors.yellow('[QS]    ')} The src of the video ${gutil.colors.cyan(src)} has a query string. Is that necessary?`);
        }

        if (src.indexOf('/') === 0) {
          file.videos.push(src);
          addStatistic('video', src);
        } else {
          file.videos.push(path.join(path.dirname(file.basePath), parsed.path));
          addStatistic('video', path.join(path.dirname(file.basePath), parsed.path));
        }
      }
    });

    $('a').each((i, el) => {
      const $el = $(el),
            href = $el.attr('href'),
            name = $el.attr('name');

      if (name) {
        file.anchors.push(name);
      }

      if (!href || href === "#") { // ignoring mailto and external links for now
        return true;
      } else if (href.indexOf('#') === 0) {
        file.anchorLinks.push(href.trim().replace('#',''));
      } else if (href.indexOf('http') === 0) {
        file.external.links.push(href.trim());
      } else if (href.indexOf('mailto') === 0) {
        file.external.mailto.push(href.trim());
      } else {
        try {
          const parsed = url.parse(href.trim());

          if (parsed.query) {
            file.warnings.push(`${gutil.colors.yellow('[QS]     ')} The link to ${gutil.colors.cyan(href)} has a query string. Is that necessary?`);
          }

          if (href.indexOf('/') === 0) {
            file.links.push(href);
          } else {
            file.links.push(path.join(path.dirname(file.basePath), href));
          }

        } catch (e) {
          verbose && console.log(`Error while parsing ${file.path} link: ${e}`);
        }
      }
    });

    $('iframe').each((i, el) => {
      const $el = $(el);
      const src = $el.attr('src');

      if (src.indexOf('youtube') !== -1) {
        addStatistic('youtube', src);
      } else {
        addStatistic('iframe_unknown', src);
      }
    });

    var lastLevel = null;
    $('h1,h2,h3,h4,h5', '.mx__page__content').each((i, el) => {
      var $el = $(el),
          id = $el.attr('id'),
          tagName = $el[0].name.toLowerCase(),
          level = parseInt(tagName.replace('h', ''), 10);

      const diff = lastLevel !== null ? level - lastLevel : 0;
      if (diff > 1) {
        file.warnings.push(`${gutil.colors.red('[TOC]    ')} There is are inconsistencies with the title sorting. Check title with text ${gutil.colors.cyan($el.text())}`);
      }
      lastLevel = level;

      if ('h1' === tagName) {
        file.errors.push(`${gutil.colors.red('[TITLE]  ')} There is a title with text ${gutil.colors.cyan($el.text())} which is an H1. This cannot happen, as this is the page title`);
      }

      if (id) {
        if (file.anchors.indexOf(id) !== -1) {
          file.warnings.push(`${gutil.colors.yellow('[ID]     ')} The element with ${gutil.colors.cyan('id="' + id + '"')} has a duplicate ID, this should not happen`);
        } else {
          file.anchors.push(id);
        }
      }
    });

    const todos = $('.todo', '.mx__page__content');
    if (todos.length) {
      file.warnings.push(`${gutil.colors.yellow('[TODO]   ')} This file has ${gutil.colors.cyan('{{% todo %}}')} elements.`);
    }

    const updateTime = $('meta[property="og:updated_time"]').attr('content');
    file.time = updateTime ? updateTime : null;

    const ogTitle = $('meta[property="og:title"]').attr('content');
    file.seoTitle = ogTitle ? ogTitle : null;
  }
  delete(file.content);

  totalChecked += 1;
  const perc = Math.floor(100 * (totalChecked / totalChecks));
  if (perc % 10 === 0 && perc !== lastParsed) {
    lastParsed = perc;
    gutil.log(`${indicator} Pages parsed: ${perc}%`);
  }

  resolve(file);
});

const parseHtmlFiles = files => {
  totalChecks = files.length;
  totalChecked = 0;
  totalValidated = 0;
  lastParsed = 0;
  lastValidated = 0;

  return Promise.all(_.map(files, file => parseHtmlFile(file)));
}

const getLinkPaths = link => {
  //TODO: GET THIS FROM CONFIG
  if (link.indexOf('/howto7/') !== -1) {
    link = link.replace(/\/howto7\//g, '/howto/');
  }
  if (link.indexOf('/refguide7/') !== -1) {
    link = link.replace(/\/refguide7\//g, '/refguide/');
  }

  const paths = [
    link,
    `${link}.html`,
    `${link}index.html`,
    `${link}/index.html`
  ];
  return paths;
}

const validateFiles = files => Promise.resolve(_.map(files, file => {

  const warningKey = 'warnings';
  const errorKey = 'errors';

  // Let's check all the links
  _.forEach(file.links, link => {
    const fullPath = normalizeSafe(path.join(SOURCEPATH, link)),
          fullUrl = url.parse(path.join(SOURCEPATH, link));

    let linkPath = (fullUrl.protocol !== null ? fullUrl.protocol : "").toUpperCase() + fullUrl.pathname; // TODO: Check how we can fix this in Windows??
    let linkedFile = _.filter(
      _.map(getLinkPaths(linkPath), linkPathPossible => _.find(
        files, findFile => findFile.path === linkPathPossible)
      ), f => !!f
    );

    if (linkedFile && linkedFile.length && linkedFile.length === 1) {
      linkedFile = _.first(linkedFile);
      if (fullUrl.hash) {
        const hashID = fullUrl.hash.replace('#', '');
        if (linkedFile.anchors.indexOf(hashID) === -1) {
          file[warningKey].push(`${gutil.colors.yellow('[ANCHOR] ')} ${gutil.colors.cyan(link)}, page ${gutil.colors.cyan(linkedFile.basePath)} exists, anchor ${gutil.colors.cyan(hashID)} does not.`);
          verbose && console.log(`hash err ${file.path} to ${linkedFile.basePath}`, link);
        }
      }
    } else if (!helpers.isFile(fullPath)) {
      file[errorKey].push(`${gutil.colors.red('[LINK]   ')} ${gutil.colors.cyan(link)} does not exist. Path: ${gutil.colors.cyan(linkPath)} (.html | index.html) is unresolved`);
      verbose && console.log(`err ${file.path}`, link);
    }
  });

  // Let's check all the images
  _.forEach(file.images, image => {
    let fullPath = path.join(SOURCEPATH, image);
    _.remove(allResidualFiles, n => n === fullPath);
    if (allFiles.indexOf(fullPath) !== -1) {
      return;
    }
    if (!helpers.isFile(fullPath)) {
      file[errorKey].push(`${gutil.colors.red('[IMAGE]  ')} ${gutil.colors.cyan(image)} does not exist. Path: ${gutil.colors.cyan(fullPath)} is unresolved`);
      verbose && console.log(`err image ${file.path}`, image);
    }
  });

  // Let's check all the videos
  _.forEach(file.videos, video => {
    let fullPath = path.join(SOURCEPATH, video);
    _.remove(allResidualFiles, n => n === fullPath);
    if (allFiles.indexOf(fullPath) !== -1) {
      return;
    }
    if (!helpers.isFile(fullPath)) {
      file[errorKey].push(`${gutil.colors.red('[VIDEO]  ')} ${gutil.colors.cyan(video)} does not exist. Path: ${gutil.colors.cyan(fullPath)} is unresolved`);
      verbose && console.log(`err image ${file.path}`, video);
    }
  });

  // Let's check anchorlinks
  _.forEach(file.anchorLinks, anchorlink => {
    if (file.anchors.indexOf(anchorlink) === -1) {
      //console.log(file.anchors);
      file[warningKey].push(`${gutil.colors.yellow('[ANCHOR] ')} ${gutil.colors.cyan('#' + anchorlink)} does not exist in page`);
      verbose && console.log(`err anchor ${file.path}`, anchorlink);
    }
  });

  totalValidated += 1;
  const perc = Math.floor(100 * (totalValidated / totalChecks));
  if (perc % 10 === 0 && perc !== lastValidated) {
    lastValidated = perc;
    gutil.log(`${indicator} Pages validated: ${perc}%`);
  }

  return file;
}));

const checkAllLinks = (links, files) => {
  return helpers
    .checkLinks(links)
    .then(results => {
      return _.map(files, file => {
        if (file.external && file.external.links) {
          file.external.links.forEach(link => {
            const res = _.find(results, result => result.url === link);
            if (res && typeof res.code !== 'undefined' && res.code !== 200 && res.code !== 301 && res.code !== 302 && res.code !== 303) {
              if (res.code === 404) {
                file.warnings.push(`External: Has link to ${gutil.colors.cyan(link)} which return a ${gutil.colors.red('Page not found')}. Please fix this`);
              } else if (res.code === 560 && (link.indexOf('home.mendix.com') !== -1 || link.indexOf('mendixcloud.com') !== -1)) {
                // Do nothing for Mendix apps
              } else {
                file.warnings.push(`External: Has link to ${gutil.colors.cyan(link)} which return a http code ${gutil.colors.cyan(res.code)}. Please check this`);
                if (res.err) {
                  file.warnings.push(`External: Has link to ${gutil.colors.cyan(link)} which has this error: ${gutil.colors.cyan(res.err)}.`);
                }
              }
            }
          })
        }
        return file;
      })
    })
}

const writeUpdateFeed = files => new Promise((resolve, reject) => {
  const updateFiles = _.chain(files)
    .filter(file => file.time !== null && !!file.seoTitle)
    .map(file => {
      const picked = _.pick(file, ['basePath', 'time', 'seoTitle']);

      picked.basePath = picked.basePath.replace('index.html', '').replace('.html','');
      picked.seoTitle = picked.seoTitle.replace(' | Mendix Evaluation Guide', '');

      const m = moment(picked.time, 'YYYY-DD-MMTHH:mm:ssZZ');
      if (m._isValid) {
        picked.timeStamp = m.unix();
        picked.dateObj = m.toDate();
      } else {
        //console.log('err');
      }
      return picked;
    })
    .sortBy(file => file.timeStamp)
    .reverse()
    .take(20)
    .value();

  const feed = new RSS({
    title: 'Mendix Evaluation Guide',
    description: 'Mendix Evaluation Guide Updates',
    generator: 'Mendix Evaluation Guide generator',
    feed_url: 'https://www.mendix.com/evaluation-guide/feed.xml',
    site_url: 'https://www.mendix.com/evaluation-guide/'
  });

  _.forEach(updateFiles, update => {
    feed.item({
      title: update.seoTitle,
      description: '',
      url: 'https://' + normalizeSafe(`www.mendix.com${update.basePath}`),
      date: update.dateObj
    })
  });

  const feedDest = path.join(SOURCEPATH, '/evaluation-guide/feed.xml');

  fs.writeFile(feedDest, feed.xml({ indent: true }), err => {
    if (err) {
      gutil.log(`${feedindicator} Error writing /feed.xml: ${err}`)
    } else {
      gutil.log(`${feedindicator} Update feed written to ${feedDest}`);
    }
    resolve(files);
  });
})

const checkExternal = files => {
  const externalChecked = 0,
        total = _.flatten(_.map(files, file => file.external && file.external.links ? file.external.links : [])),
        uniq = _.uniq(total).filter(url => !/github\.com|localhost|linkedin\.com|facebook\.com|twitter\.com|world\.mendix\.com/.test(url)); // we ignore github, Linkedin, Facebook, and Twitter links for now - would be nice to get a proper description of the error instead!

  if (!EXTERNAL) {
    return files;
  }
  return checkAllLinks(uniq, files);
}

const checkHTMLFiles = (opts) => helpers.getFiles(SOURCEPATH)
  .then(helpers.readHtmlFiles)
  .then(parseHtmlFiles)
  .then(validateFiles)
  .then(checkExternal)
  .then(writeUpdateFeed)
  .then(files => {
    const errors = _.filter(files, file => file.errors.length > 0),
          warnings = _.filter(files, file => file.warnings.length > 0);

    gutil.log(`${gutil.colors.cyan('[HTML CHECK]')} ====== REPORT =====`)
    console.log(`\nFinished checking ${files.length} files`);
    console.log('\n======= Errors: ' + errors.length);
    if (errors.length > 0) {
      _.forEach(errors, file => {
        console.log(`\nFile: ${gutil.colors.cyan(file.basePath)} has the following errors:\n`);
        _.forEach(file.errors, error => {
          console.log(gutil.colors.red('   + ') + error);
        })
      })
    }
    console.log('\n======= Warnings: ' + warnings.length);
    if (warnings.length > 0) {
      _.forEach(warnings, file => {
        console.log(`\nFile: ${gutil.colors.cyan(file.basePath)} has the following warnings:\n`);
        _.forEach(file.warnings, error => {
          console.log(gutil.colors.yellow('   + ') + error);
        })
      })
    }
    console.log('');

    const unusedMediaFiles = _.filter(allResidualFiles,
      f => f.indexOf('/attachments/') !== -1 &&
      (f.indexOf('.png') !== -1 || f.indexOf('.jpg') !== -1 || f.indexOf('.jpeg') !== -1 || f.indexOf('.mp4') !== -1));

    if (DELETE_UNUSED_IMAGES) {
      _.forEach(unusedMediaFiles, file => {
        // This is diry, should be done differently
        const f = file.replace('/_site/', '/content/');
        console.log(`Deleting ${gutil.colors.cyan(f)}`);
        shell.rm('-rf', f);
      })
    }

    let indexMappingHeader = [
      '############################################################################################',
      `# Mendix indexes redirect mapping, generated from \'gulp check:html\'`,
      '############################################################################################',
      ''
    ];
    let indexFiles = _.chain(files)
      .filter(file =>
        file.basePath.indexOf('/index.html') !== -1 &&
        file.basePath !== '/index.html' &&
        file.basePath !== '/search/index.html'
      )
      .map(file => { return {
        to: file.basePath.replace(/index\.html/, ''),
        from: file.basePath.replace(/\/index\.html/, '')
      }; })
      .sortBy(file => file.from.length)
      .map(file => `${file.from} ${file.to};`)
      .value();

    let indexes = indexMappingHeader.concat(indexFiles).join('\n');
    const indexDest = path.join(SOURCEPATH, '/mappings/indexes.map');

    fs.writeFile(indexDest, indexes, err => {
      if (err) {
        gutil.log(`Error writing index mappings: ${err}`)
        opts.callback(true);
      } else {
        gutil.log(`Index mappings written to ${indexDest}`);
        if (errors.length === 0) {
          if (files.length === 0) {
            console.log(`It seems there are no files to check. This looks bad`);
            opts.callback(true);
          } else {
            opts.callback(false);
          }
        } else {
          opts.callback(true);
        }
      }
    });
  })
  .catch(err => {
    helpers.gulpErr('htmlproofer', err);
    opts.callback(true);
  });

const checkFiles = (opts) => {
  SOURCEPATH = normalizeSafe(opts.dir);
  EXTERNAL = opts.external || false;
  gutil.log(`${indicator} Testing html in ${SOURCEPATH}`);
  helpers
    .getAllFiles(SOURCEPATH)
    .then(files => {
      allFiles = files;
      allResidualFiles = files;
      return checkHTMLFiles(opts);
    })
    .then(() => {
      gutil.log(` `);
      gutil.log(gutil.colors.cyan(`Statistics: `));
      gutil.log(`    Images:         ${gutil.colors.cyan(statistics.image.length)}`);
      gutil.log(`    Videos:         ${gutil.colors.cyan(statistics.video.length)}`);
      gutil.log(`    Youtube video:  ${gutil.colors.cyan(statistics.youtube.length)}`);
      gutil.log(`    Unknown iframe: ${gutil.colors.cyan(statistics.iframe_unknown.length)}`);
      gutil.log(` `);
    })
    .catch(err => {
      helpers.gulpErr('htmlproofer', err);
      opts.callback(true);
    });
};

module.exports = {
  check: checkFiles
};
