import E from '@unseenco/e'
import { appendScript, parseDom, processUrl, reloadScript } from './helpers'
import Transition from './Transition'
import Renderer from './Renderer'
import RouteStore from './RouteStore'

const IN_PROGRESS = 'A transition is currently in progress'

/**
 * @typedef CacheEntry
 * @type {object}
 * @property {Renderer} renderer
 * @property {Document|Node} page
 * @property {array} scripts
 * @property {boolean} skipCache
 * @property {string} title
 * @property {HTMLElement|Element} content
 */

export default class Core {
	isTransitioning = false

	/**
	 * @type {CacheEntry|null}
	 */
	currentCacheEntry = null

	/**
	 * @type {Map<string, CacheEntry>}
	 */
	cache = new Map()

	/**
	 * @param {{
	 * 		links?: string,
	 * 		removeOldContent?: boolean,
	 * 		allowInterruption?: boolean,
	 * 		bypassCache?: boolean,
	 * 		renderers?: Object.<string, Renderer>,
	 * 		transitions?: Object.<string, Transition>,
	 * 		reloadJsFilter?: boolean|function(HTMLElement): boolean
	 * }} parameters
	 */
	constructor(parameters = {}) {
		const {
			links = 'a:not([target]):not([href^=\\#]):not([data-taxi-ignore])',
			removeOldContent = true,
			allowInterruption = false,
			bypassCache = false,
			renderers = {
				default: Renderer
			},
			transitions = {
				default: Transition
			},
			reloadJsFilter = (element) => element.dataset.taxiReload !== undefined
		} = parameters

		this.renderers = renderers
		this.transitions = transitions
		this.defaultRenderer = this.renderers.default || Renderer
		this.defaultTransition = this.transitions.default || Transition
		this.wrapper = document.querySelector('[data-taxi]')
		this.reloadJsFilter = reloadJsFilter
		this.removeOldContent = removeOldContent
		this.allowInterruption = allowInterruption
		this.bypassCache = bypassCache
		this.cache = new Map()
		this.isPopping = false

		// Add delegated link events
		this.attachEvents(links)

		this.currentLocation = processUrl(window.location.href)

		// as this is the initial page load, prime this page into the cache
		this.cache.set(this.currentLocation.href, this.createCacheEntry(document.cloneNode(true)))

		// fire the current Renderer enter methods
		this.currentCacheEntry = this.cache.get(this.currentLocation.href)
		this.currentCacheEntry.renderer.initialLoad()
	}

	/**
	 * @param {string} renderer
	 */
	setDefaultRenderer(renderer) {
		this.defaultRenderer = this.renderers[renderer]
	}

	/**
	 * @param {string} transition
	 */
	setDefaultTransition(transition) {
		this.defaultTransition = this.transitions[transition]
	}

	/**
	 * Registers a route into the RouteStore
	 *
	 * @param {string} fromPattern
	 * @param {string} toPattern
	 * @param {string} transition
	 */
	addRoute(fromPattern, toPattern, transition) {
		if (!this.router) {
			this.router = new RouteStore()
		}

		this.router.add(fromPattern, toPattern, transition)
	}

	/**
	 * Prime the cache for a given URL
	 *
	 * @param {string} url
	 * @param {boolean} [preloadAssets]
	 * @return {Promise}
	 */
	preload(url, preloadAssets = false) {
		// convert relative URLs to absolute
		url = processUrl(url).href

		if (!this.cache.has(url)) {
			return this.fetch(url, false)
				.then(async (newPage) => {
					this.cache.set(url, this.createCacheEntry(newPage))

					if (preloadAssets) {
						this.cache.get(url).renderer.createDom()
					}
				})
		}

		return Promise.resolve()
	}

	/**
	 * Updates the HTML cache for a given URL.
	 * If no URL is passed, then cache for the current page is updated.
	 * Useful when adding/removing content via AJAX such as a search page or infinite loader.
	 *
	 * @param {string} [url]
	 */
	updateCache(url) {
		const key = processUrl(url || window.location.href).href

		if (this.cache.has(key)) {
			this.cache.delete(key)
		}

		this.cache.set(key, this.createCacheEntry(document.cloneNode(true)))
	}

	/**
	 * Clears the cache for a given URL.
	 * If no URL is passed, then cache for the current page is cleared.
	 *
	 * @param {string} [url]
	 */
	clearCache(url) {
		const key = processUrl(url || window.location.href).href

		if (this.cache.has(key)) {
			this.cache.delete(key)
		}
	}

	/**
	 * @param {string} url
	 * @param {string|false} [transition]
	 * @param {string|false|HTMLElement} [trigger]
	 * @return {Promise<void|Error>}
	 */
	navigateTo(url, transition = false, trigger = false) {
		return new Promise((resolve, reject) => {
			// Don't allow multiple navigations to occur at once
			if (!this.allowInterruption && this.isTransitioning) {
				reject(new Error(IN_PROGRESS))
				return
			}

			this.isTransitioning = true
			this.isPopping = true
			this.targetLocation = processUrl(url)
			this.popTarget = window.location.href

			const TransitionClass = new (this.chooseTransition(transition))({ wrapper: this.wrapper })

			let navigationPromise

			if (this.bypassCache || !this.cache.has(this.targetLocation.href) || this.cache.get(this.targetLocation.href).skipCache) {
				const fetched = this.fetch(this.targetLocation.raw)
					.then((newPage) => {
						this.cache.set(this.targetLocation.href, this.createCacheEntry(newPage))
						this.cache.get(this.targetLocation.href).renderer.createDom()
					})

				navigationPromise = this.beforeFetch(this.targetLocation, TransitionClass, trigger)
					.then(async () => {
						return fetched.then(async (newPage) => {
							return await this.afterFetch(this.targetLocation, TransitionClass, this.cache.get(this.targetLocation.href), trigger)
						})
					})
			} else {
				this.cache.get(this.targetLocation.href).renderer.createDom()

				navigationPromise = this.beforeFetch(this.targetLocation, TransitionClass, trigger)
					.then(async () => {
						return await this.afterFetch(this.targetLocation, TransitionClass, this.cache.get(this.targetLocation.href), trigger)
					})
			}

			navigationPromise.then(() => {
				resolve()
			})
		})
	}

	/**
	 * Add an event listener.
	 * @param {string} event
	 * @param {any} callback
	 */
	on(event, callback) {
		E.on(event, callback)
	}

	/**
	 * Remove an event listener.
	 * @param {string} event
	 * @param {any} [callback]
	 */
	off(event, callback) {
		E.off(event, callback)
	}

	/**
	 * @private
	 * @param {{ raw: string, href: string, hasHash: boolean, pathname: string }} url
	 * @param {Transition} TransitionClass
	 * @param {string|HTMLElement|false} trigger
	 * @return {Promise<void>}
	 */
	beforeFetch(url, TransitionClass, trigger) {
		E.emit('NAVIGATE_OUT', {
			from: this.currentCacheEntry,
			trigger
		})

		return new Promise((resolve) => {
			this.currentCacheEntry.renderer.leave(TransitionClass, trigger, this.removeOldContent)
				.then(() => {
					if (trigger !== 'popstate') {
						window.history.pushState({}, '', url.raw)
					}

					resolve()
				})
		})
	}

	/**
	 * @private
	 * @param {{ raw: string, href: string, host: string, hasHash: boolean, pathname: string }} url
	 * @param {Transition} TransitionClass
	 * @param {CacheEntry} entry
	 * @param {string|HTMLElement|false} trigger
	 * @return {Promise<void>}
	 */
	afterFetch(url, TransitionClass, entry, trigger) {
		this.currentLocation = url
		this.popTarget = this.currentLocation.href

		return new Promise((resolve) => {
			entry.renderer.update()

			E.emit('NAVIGATE_IN', {
				from: this.currentCacheEntry,
				to: entry,
				trigger
			})

			if (this.reloadJsFilter) {
				this.loadScripts(entry.scripts)
			}

			entry.renderer.enter(TransitionClass, trigger)
				.then(() => {
					E.emit('NAVIGATE_END', {
						from: this.currentCacheEntry,
						to: entry,
						trigger
					})

					this.currentCacheEntry = entry
					this.isTransitioning = false
					this.isPopping = false
					resolve()
				})
		})
	}

	/**
	 * Load up scripts from the target page if needed
	 *
	 * @param {HTMLElement[]} cachedScripts
	 */
	loadScripts(cachedScripts) {
		const newScripts = [...cachedScripts]
		const currentScripts = Array.from(document.querySelectorAll('script')).filter(this.reloadJsFilter)

		// loop through all new scripts
		for (let i = 0; i < currentScripts.length; i++) {
			for (let n = 0; n < newScripts.length; n++) {
				if (currentScripts[i].outerHTML === newScripts[n].outerHTML) {
					reloadScript(currentScripts[i])
					newScripts.splice(n, 1)
					break
				}
			}
		}

		for (const script of newScripts) {
			appendScript(script)
		}
	}

	/**
	 * @private
	 * @param {string} links
	 */
	attachEvents(links) {
		E.delegate('click', links, this.onClick)
		E.on('popstate', window, this.onPopstate)
	}

	/**
	 * @private
	 * @param {MouseEvent} e
	 */
	onClick = (e) => {
		if (!(e.metaKey || e.ctrlKey)) {
			const target = processUrl(e.currentTarget.href)
			this.currentLocation = processUrl(window.location.href)

			if (this.currentLocation.host !== target.host) {
				return
			}

			// the target is a new URL, or is removing the hash from the current URL
			if (this.currentLocation.href !== target.href || (this.currentLocation.hasHash && !target.hasHash)) {
				e.preventDefault()
				// noinspection JSIgnoredPromiseFromCall
				this.navigateTo(target.raw, e.currentTarget.dataset.transition || false, e.currentTarget).catch(err => console.warn(err))
				return
			}

			// a click to the current URL was detected
			if (!this.currentLocation.hasHash && !target.hasHash) {
				e.preventDefault()
			}
		}
	}

	/**
	 * @private
	 * @return {void|boolean}
	 */
	onPopstate = () => {
		// don't trigger for on-page anchors
		if (window.location.pathname === this.currentLocation.pathname && !this.isPopping) {
			return false
		}

		if (!this.allowInterruption && (this.isTransitioning || this.isPopping)) {
			// overwrite history state with current page if currently navigating
			window.history.pushState({}, '', this.popTarget)
			console.warn(IN_PROGRESS)
			return false
		}

		if (!this.isPopping) {
			this.popTarget = window.location.href
		}

		this.isPopping = true

		// noinspection JSIgnoredPromiseFromCall
		this.navigateTo(window.location.href, false, 'popstate')
	}

	/**
	 * @private
	 * @param {string} url
	 * @param {boolean} [runFallback]
	 * @return {Promise<Document>}
	 */
	fetch(url, runFallback = true) {
		return new Promise((resolve, reject) => {
			fetch(url, {
				mode: 'same-origin',
				method: 'GET',
				headers: { 'X-Requested-With': 'Taxi' },
				credentials: 'same-origin'
			})
				.then((response) => {
					if (!response.ok) {
						reject('Taxi encountered a non 2xx HTTP status code')

						if (runFallback) {
							window.location.href = url
						}
					}

					return response.text()
				})
				.then((htmlString) => {
					resolve(parseDom(htmlString))
				})
				.catch((err) => {
					reject(err)

					if (runFallback) {
						window.location.href = url
					}
				})
		})
	}

	/**
	 * @private
	 * @param {string|false} transition
	 * @return {Transition|function}
	 */
	chooseTransition(transition) {
		if (transition) {
			return this.transitions[transition]
		}

		const routeTransition = this.router?.findMatch(this.currentLocation, this.targetLocation)

		if (routeTransition) {
			return this.transitions[routeTransition]
		}

		return this.defaultTransition
	}

	/**
	 * @private
	 * @param {Document|Node} page
	 * @return {CacheEntry}
	 */
	createCacheEntry(page) {
		const content = page.querySelector('[data-taxi-view]')
		const Renderer = content.dataset.taxiView.length ? this.renderers[content.dataset.taxiView] : this.defaultRenderer

		if (!Renderer) {
			console.warn(`The Renderer "${content.dataset.taxiView}" was set in the data-taxi-view of the requested page, but not registered in Taxi.`)
		}

		return {
			page,
			content,
			skipCache: content.hasAttribute('data-taxi-nocache'),
			scripts: this.reloadJsFilter ? Array.from(page.querySelectorAll('script')).filter(this.reloadJsFilter) : [],
			title: page.title,
			renderer: new Renderer({
				wrapper: this.wrapper,
				title: page.title,
				content,
				page
			})
		}
	}
}
