"use strict"

const RBXPreview = (() => {
	let avatarRulePromise
	function getAvatarRules() {
		if(!avatarRulePromise) {
			const url = "https://avatar.roblox.com/v1/avatar-rules"
			let retries = 0

			const callback = async resp => {
				if(!resp.ok) {
					if(++retries > 5) {
						console.warn(`[RBXPreview] Failed to load '${url}'`)
						return
					}

					await new SyncPromise(res => setTimeout(res, 1e3))
					return csrfFetch(url, { credentials: "include" }).then(callback)
				}

				return resp.json()
			}

			avatarRulePromise = csrfFetch(url, { credentials: "include" }).then(callback)
		}

		return avatarRulePromise
	}

	function getAvatarData() {
		const url = "https://avatar.roblox.com/v1/avatar"
		let retries = 0

		const callback = async resp => {
			if(!resp.ok) {
				if(++retries > 5) {
					console.warn(`[RBXPreview] Failed to load '${url}'`)
					return
				}

				await new SyncPromise(res => setTimeout(res, 1e3))
				return csrfFetch(url, { credentials: "include" }).then(callback)
			}

			return resp.json()
		}

		return csrfFetch(url, { credentials: "include" }).then(callback)
	}

	function getDefaultAppearance(cb) {
		SyncPromise.all([getAvatarRules(), getAvatarData()]).then(([rules, data]) => {
			const bodyColors = {}

			Object.entries(data.bodyColors).forEach(([name, value]) => {
				const index = name.toLowerCase().replace(/colorid$/, "")
				const bodyColor = rules.bodyColorsPalette.find(x => x.brickColorId === value)
				bodyColors[index] = bodyColor.hexColor
			})

			data.bodyColors = bodyColors
			cb(data, rules)
		})
	}

	class Previewer extends EventEmitter {
		constructor() {
			super()

			this.enabled = false
			this.initialized = false
		}

		setEnabled(bool) {
			this.enabled = !!bool

			if(this.enabled) {
				if(!this.initialized) {
					this.initialized = true
					this.trigger("init")
				}
				this.trigger("enabled")
			} else {
				this.trigger("disabled")
			}
		}
	}

	class AvatarPreviewer extends Previewer {
		constructor(opts = {}) {
			super()
			this.container = html`<div style="width:100%; height:100%;"></div>`

			this.playerType = null
			this.anims = []
			this.assetMap = {}
			this.previewMap = {}

			this.animLoadCounter = 0
			this.currentAnim = null

			this.autoLoadPlayerType = true
			this.accessoriesVisible = true
			this.packagesVisible = true
			this.disableDefaultAnimations = "disableDefaultAnimations" in opts ? opts.disableDefaultAnimations : false

			this.appearance = null
			this.waitForAppearance = "waitForAppearance" in opts ? opts.waitForAppearance : true
			this.appearanceLoadedPromise = new SyncPromise()

			this.scene = new RBXScene.AvatarScene()
			this.container.append(this.scene.canvas)

			const avatar = this.scene.avatar

			const R15Anims = [507766666, 507766951, 507766388]
			const R6Anims = [180435792, 180435571]

			avatar.animator.onloop = () => {
				if(!this.currentAnim) {
					if(R15Anims.includes(this.playingAnim)) {
						const roll = Math.random()
						const animId = roll < 1 / 11 ? R15Anims[0] : roll < 2 / 11 ? R15Anims[1] : R15Anims[2]
						if(this.currentAnim !== animId) {
							this.loadAnimation(animId, .5)
						}
					} else if(R6Anims.includes(this.playingAnim)) {
						const roll = Math.random()
						const animId = roll < 0.1 ? R6Anims[0] : R6Anims[1]
						if(this.currentAnim !== animId) {
							this.loadAnimation(animId, .5)
						}
					}
				}
			}

			avatar.animator.onstop = () => setTimeout(() => avatar.animator.play(), 2000)

			this.on("enabled", () => {
				this.scene.start()

				if(!this.playingAnim) {
					if(this.currentAnim) {
						this.loadAnimation(this.currentAnim.assetId)
					} else if(!this.disableDefaultAnimations) {
						this.loadDefaultAnimation()
					}
				}
			})

			this.on("disabled", () => {
				this.scene.stop()
			})

			this.on("init", () => {
				getDefaultAppearance((data, rules) => {
					this.avatarRules = rules
					this.appearance = data

					this.trigger("avatarRulesLoaded")
					
					this.scene.avatar.setBodyColors(data.bodyColors)
	
					if(this.packagesVisible) {
						this.scene.avatar.setScales(data.scales)
					}
	
					if(!this.playerType && this.autoLoadPlayerType) {
						this.setPlayerType(data.playerAvatarType)
					}

					data.assets.map(asset => this.addAsset(asset.id, asset.assetType.id))
					this.appearanceLoadedPromise.resolve()
				})
				
				if(this.waitForAppearance) {
					setTimeout(() => {
						this.waitForAppearance = false
	
						if(!this.playerType) {
							this.setPlayerType("R15")
							this.playerType = null
						}
	
						this.appearanceLoadedPromise.resolve()
					}, 2e3)
				}
			})
		}

		setPlayerType(type) {
			if(this.playerType === type) { return }

			this.playerType = type
			this.scene.avatar.setPlayerType(type)

			if(!this.currentAnim && !this.disableDefaultAnimations) {
				this.loadDefaultAnimation()
			}

			this.trigger("playertypechanged", type)
		}

		setPackagesVisible(bool) {
			const visible = this.packagesVisible = !!bool

			Object.values(this.assetMap).forEach(asset => {
				if(asset.bodyparts.length || asset.clothing.length) {
					asset.setEnabled(visible)
				}
			})

			if(visible) {
				if(this.appearance) {
					this.scene.avatar.setScales(this.appearance.scales)
				}
			} else {
				this.scene.avatar.setScales({
					width: 1,
					height: 1,
					depth: 1,
					head: 1,
					proportion: 0,
					bodyType: 0
				})
			}

			this.scene.avatar.shouldRefreshBodyParts = true
			this.trigger("packagesToggled")
		}

		setAccessoriesVisible(bool) {
			const visible = this.accessoriesVisible = !!bool

			Object.values(this.assetMap).forEach(asset => {
				if(asset.accessories.length) {
					asset.setEnabled(visible)
				}
			})
		}

		addAssetPreview(assetId, assetTypeId) {
			if(this.previewMap[assetId]) { return }
			const asset = this.scene.avatar.addAsset(assetId, assetTypeId)

			if(asset) {
				this.previewMap[assetId] = asset
				asset.setPriority(2)
				asset.once("remove", () => {
					delete this.previewMap[assetId]
				})
			}

			return SyncPromise.resolve()
		}

		removeAssetPreview(assetId) {
			const asset = this.previewMap[assetId]
			if(asset) {
				asset.remove()
			}
		}

		addAsset(assetId, assetTypeId) {
			if(this.assetMap[assetId]) { return }
			const asset = this.scene.avatar.addAsset(assetId, assetTypeId)

			if(asset) {
				this.assetMap[assetId] = asset
				asset.once("remove", () => {
					delete this.assetMap[assetId]
				})
			}
			
			return SyncPromise.resolve()
		}

		removeAsset(assetId) {
			const asset = this.assetMap[assetId]
			if(asset) {
				asset.remove()
			}
		}

		loadDefaultAnimation() {
			this.scene.avatar.animator.pause()
			this.playingAnim = null

			if(this.enabled) {
				const animId = this.playerType === "R15" ? 507766388 : 180435571
				this.loadAnimation(animId)
			} else {
				this.animLoadCounter++
			}
		}

		loadAnimation(assetId, fadeIn) {
			const index = ++this.animLoadCounter

			AssetCache.loadAnimation(assetId, data => {
				if(this.animLoadCounter !== index) { return }

				if(this.setPlayerTypeOnAnim && this.currentAnim) {
					this.setPlayerTypeOnAnim = false
					const R6AnimParts = ["Torso", "Left Arm", "Right Arm", "Left Leg", "Right Leg"]
					const isR6 = R6AnimParts.some(x => x in data.keyframes)
					this.setPlayerType(isR6 ? "R6" : "R15")
				}

				this.playingAnim = assetId
				this.scene.avatar.animator.play(data, fadeIn || 0)
				this.trigger("animationloaded", data, assetId)
			})
		}

		playAnimation(name) {
			const anim = this.anims.find(x => x.name === name)
			if(!anim) { return }

			this.currentAnim = anim
			this.scene.avatar.animator.pause()
			this.playingAnim = null

			if(this.enabled) {
				this.loadAnimation(anim.assetId)
			} else {
				this.animLoadCounter++
			}
		}

		addAnimation(name, assetId) {
			this.anims.push({ name, assetId })
		}
	}

	return {
		AvatarPreviewer
	}
})()