'use strict';

/**
 * index.js — Public API for the statico engine.
 * Consumers importing statico programmatically use this.
 */

module.exports = {
  // Core engine modules
  resolver:  require('./engine/resolver'),
  registry:  require('./engine/registry'),
  context:   require('./engine/context'),
  pipeline:  require('./engine/pipeline'),
  validator: require('./engine/validator'),
  steps:     require('./engine/steps'),
  logger:    require('./engine/logger'),
  interceptors: require('./engine/interceptors'),

  // CLI actions
  build:     require('./cli/build').build,
  init:      require('./init/init').initSite,
};
