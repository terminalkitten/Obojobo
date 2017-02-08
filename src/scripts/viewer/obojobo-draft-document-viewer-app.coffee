"use strict";

loadModule = require '../loadmodule'

Viewer = window.Viewer
ViewerApp = Viewer.components.ViewerApp

moduleId = decodeURIComponent(document.location.hash).substr(1)

loadModule moduleId, (items) ->
	console.log(items);
	items.module = items.module.constructor.createFromDescriptor null, JSON.parse(window.localStorage.__module)
	ReactDOM.render `<ViewerApp
						module={items.module}
						chunks={items.chunks}
						insertItems={items.insertItems}
						toolbarItems={items.toolbarItems}
					/>`, document.getElementById('viewer-app')