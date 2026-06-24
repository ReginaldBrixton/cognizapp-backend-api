import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'

const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
const email = process.env.LIVE_AUTH_EMAIL || `codex.live.${Date.now()}.${randomUUID().slice(0, 8)}@example.com`
const password = process.env.LIVE_AUTH_PASSWORD || `Codex!${Date.now()}Aa`
const fullName = process.env.LIVE_AUTH_NAME || 'Codex Live User'
const chromiumExecutablePath =
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
	'C:\\Users\\REGINALD\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe'

function withBase(pathname) {
	return new URL(pathname, frontendUrl).toString()
}

async function getBodyText(page) {
	return (await page.locator('body').textContent().catch(() => '')) || ''
}

async function waitForAuthCompletion(page, sourcePath) {
	const deadline = Date.now() + 120_000
	let lastBodyText = ''

	while (Date.now() < deadline) {
		const currentUrl = new URL(page.url())
		const bodyText = await getBodyText(page)
		lastBodyText = bodyText
		if (bodyText.includes('Authentication Failed')) {
			throw new Error(`Auth callback failed on ${currentUrl.pathname}: ${bodyText.slice(0, 400)}`)
		}

		const hasAccessCookie = (await page.context().cookies()).some(
			(cookie) => cookie.name === 'cognizap_access_token' && Boolean(cookie.value),
		)
		const path = currentUrl.pathname
		const isSettledPath =
			path !== sourcePath &&
			path !== '/auth/callback' &&
			path !== '/login' &&
			path !== '/register'

		if (hasAccessCookie && isSettledPath) {
			return page.url()
		}

		if (hasAccessCookie && path === '/list') {
			return page.url()
		}

		await page.waitForTimeout(1000)
	}

	throw new Error(
		`Timed out waiting for auth completion from ${sourcePath}; last URL ${page.url()}; body=${lastBodyText.slice(0, 400)}`,
	)
}

async function collectSessionState(page) {
	const cookies = await page.context().cookies()
	const accessCookie = cookies.find((cookie) => cookie.name === 'cognizap_access_token')
	const refreshCookie = cookies.find(
		(cookie) => cookie.name === 'refresh_token' || cookie.name === 'cognizap_refresh_token',
	)

	return {
		url: page.url(),
		hasAccessCookie: Boolean(accessCookie?.value),
		hasRefreshCookie: Boolean(refreshCookie?.value),
	}
}

async function warmPage(browser, route, requiredSelector) {
	const context = await browser.newContext()
	const page = await context.newPage()

	await page.goto(withBase(route), { waitUntil: 'domcontentloaded' })
	await page.waitForSelector(requiredSelector, { timeout: 60_000 })
	await page.waitForTimeout(5000)

	await context.close()
}

async function runRegisterFlow(browser) {
	const context = await browser.newContext()
	const page = await context.newPage()

	await page.goto(withBase('/register'), { waitUntil: 'domcontentloaded' })
	await page.waitForSelector('#name', { timeout: 60_000 })
	await page.waitForTimeout(3000)
	await page.locator('#name').fill(fullName)
	await page.locator('#email').fill(email)
	await page.locator('#password').fill(password)
	await page.locator('#confirmPassword').fill(password)
	await page.getByRole('button', { name: /Create Account/i }).click()

	await waitForAuthCompletion(page, '/register')
	const state = await collectSessionState(page)
	await context.close()
	return state
}

async function runLoginFlow(browser) {
	const context = await browser.newContext()
	const page = await context.newPage()

	await page.goto(withBase('/login'), { waitUntil: 'domcontentloaded' })
	await page.waitForSelector('#email', { timeout: 60_000 })
	await page.waitForTimeout(3000)
	await page.locator('#email').fill(email)
	await page.locator('#password').fill(password)
	await page.getByRole('button', { name: /Sign In/i }).click()

	await waitForAuthCompletion(page, '/login')
	const state = await collectSessionState(page)
	await context.close()
	return state
}

async function runForgotPasswordFlow(browser) {
	const context = await browser.newContext()
	const page = await context.newPage()

	await page.goto(withBase('/forgot-password'), { waitUntil: 'domcontentloaded' })
	await page.waitForSelector('#email', { timeout: 60_000 })
	await page.waitForTimeout(3000)
	await page.locator('#email').fill(email)
	await page.locator('button[type="submit"]').click()
	await page.getByText('Password reset email sent! Check your inbox.').first().waitFor({
		state: 'visible',
		timeout: 60_000,
	})

	const bodyText = await getBodyText(page)
	await context.close()

	return {
		successMessageVisible: bodyText.includes('Password reset email sent! Check your inbox.'),
		url: page.url(),
	}
}

async function runGooglePopupFlow(browser, route) {
	const context = await browser.newContext()
	const page = await context.newPage()

	for (let attempt = 1; attempt <= 2; attempt += 1) {
		await page.goto(withBase(route), { waitUntil: 'domcontentloaded' })
		await page.getByRole('button', { name: /Continue with Google/i }).waitFor({
			state: 'visible',
			timeout: 60_000,
		})
		await page.waitForTimeout(3000)

		let popup
		try {
			const popupPromise = page.waitForEvent('popup', { timeout: 30_000 })
			await page.getByRole('button', { name: /Continue with Google/i }).click()
			popup = await popupPromise
		} catch (error) {
			if (attempt < 2) {
				continue
			}

			const bodyText = await getBodyText(page)
			await context.close()
			return {
				success: false,
				error: `Google popup did not open on ${route}`,
				bodySnippet: bodyText.slice(0, 400),
				mainPageUrl: page.url(),
			}
		}

		await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {})

		const deadline = Date.now() + 30_000
		let popupUrl = popup.url()
		let popupTitle = await popup.title().catch(() => '')

		while (Date.now() < deadline) {
			popupUrl = popup.url()
			popupTitle = popupTitle || (await popup.title().catch(() => ''))
			if (popupUrl.includes('accounts.google.com') || popupTitle.toLowerCase().includes('google')) {
				break
			}

			if (popup.isClosed()) {
				break
			}

			await popup.waitForTimeout(500)
		}

		const bodyText = await getBodyText(popup).catch(() => '')
		const result = {
			success: true,
			url: popupUrl,
			title: popupTitle,
			popupClosed: popup.isClosed(),
			isGooglePage:
				popupUrl.includes('accounts.google.com') ||
				popupTitle.toLowerCase().includes('google') ||
				bodyText.toLowerCase().includes('google'),
			mainPageUrl: page.url(),
		}

		if (!popup.isClosed()) {
			await popup.close().catch(() => {})
		}

		if (result.isGooglePage) {
			await context.close()
			return result
		}

		if (attempt === 2) {
			await context.close()
			return {
				...result,
				success: false,
				error: `Google popup on ${route} did not reach a Google page`,
			}
		}
	}

	await context.close()
	return {
		success: false,
		error: `Google popup flow on ${route} exhausted retries`,
		mainPageUrl: page.url(),
	}
}

const browser = await chromium.launch({
	headless: true,
	executablePath: chromiumExecutablePath,
})

try {
	await warmPage(browser, '/register', '#name')
	await warmPage(browser, '/login', '#email')
	await warmPage(browser, '/forgot-password', '#email')

	const results = {
		frontendUrl,
		email,
		password,
		fullName,
		register: await runRegisterFlow(browser),
		login: await runLoginFlow(browser),
		forgotPassword: await runForgotPasswordFlow(browser),
		googleLogin: await runGooglePopupFlow(browser, '/login'),
		googleRegister: await runGooglePopupFlow(browser, '/register'),
	}

	console.log(JSON.stringify(results, null, 2))
} finally {
	await browser.close()
}
