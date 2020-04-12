const fs = require('fs');
const util = require('util');
const chalk = require('chalk');
const pdfFiller = require('pdffiller');
const YAML = require('js-yaml');
const getHelpers = require('./helpers');

const { promises: afs } = fs;
const log = require('debug')('pdffiller-engine');
pdfFiller.fillFormWithFlattenAsync = util.promisify(pdfFiller.fillFormWithFlatten);

/**
 * Creates a fillable form from a PDF.
 */
class Form {
	/**
	 * Initialize the form.  The `map` and `config` can be a string or an
	 * object.  If it is a string, then it will be read in as a YAML file.
	 * The `map` was previously generated from a PDF document using the
	 * {@link map} function.
	 *
	 * @param {string} formName - A unique name for the form.
	 * @param {string|object} map - The map generated from {@link map}.
	 * @param {string|object} config - The config used by the filler script.
	 * @public
	 * @async
	 */
	async init(formName, map, config) {
		ensureNotUsingReservedKeys(config);
		this.formName = formName;
		this.config = await loadYAML(config);
		this.map = await loadYAML(map);
		this.ctx = {
			...this.config,
			forms: {
				[this.formName]: {}
			}
		};
	}

	/**
	 * Fills a form.  The `filler` can be a string or an object.  If it is a
	 * string, then it will be read in as a YAML file.
	 *
	 * @param {string|object} filler - The form filler script.
	 * @public
	 * @async
	 */
	async fill(filler) {
		filler = await loadYAML(filler);
		for (const friendlyKey in filler) {
			let fieldId;
			let fieldIndex;
			let fillValue;

			if (filler[friendlyKey].value) {
				log('updateForm calculate', friendlyKey);
				// this is a calculation. first, compute the value
				const value = evalTemplate(this.config, filler[friendlyKey].value);
				log('updateForm calculate value:', value);

				// run through calculate function
				const {
					field,
					fill
				} = evalCalculate(this.config, filler[friendlyKey].calculate, value);

				log('updateForm calculated:', { field, fill });

				fieldIndex = field;
				fieldId = findField(this.map, fieldIndex);
				fillValue = fill;
			} else {
				log('updateForm index lookup', friendlyKey);
				const ids = Object.keys(filler[friendlyKey]);
				if (ids.length !== 1) {
					throw new Error(`${friendlyKey} has more than 1 field to fill`);
				}
				fieldIndex = ids[0];
				log('updateForm index id:', fieldIndex);
				fieldId = findField(this.map, fieldIndex);
				fillValue = evalTemplate(this.config, filler[friendlyKey][fieldIndex]);
			}
			if (!fieldId) {
				throw new Error(`failed to find field index '${fieldIndex}' in field map`);
			}

			log('input', chalk.cyan(friendlyKey), '=>',
				chalk.cyan(fieldIndex), '=>', chalk.cyan(fieldId));

			fillFormField(this.ctx, this.formName, friendlyKey, fieldId, fillValue);
		}
	}

	/**
	 * Opens the PDF `source` form, fills out the form and writes it to
	 * `dest`.
	 *
	 * @param {string} source - The source PDF document.
	 * @param {string} dest - The dest PDF document.
	 * @public
	 * @async
	 */
	async save(source, dest) {
		log('fill', { source, dest });
		const filled = this.ctx.forms[this.formName];
		return pdfFiller.fillFormWithFlattenAsync(source, dest, filled, false);
	}
}

/**
 * @private
 */
function findField(map, fieldIndex) {
	for (const fieldId in map) {
		if (map[fieldId] === fieldIndex) {
			return fieldId;
		}
	}
}

/**
 * @private
 */
function fillFormField(ctx, formName, friendlyKey, fieldId, value) {
	log('filling', chalk.yellow(`${formName} ${fieldId}=${value}`));

	// Fill the form field with the value
	ctx.forms[formName][fieldId] = value;

	// Also fill the friendly key
	ctx.forms[formName][friendlyKey] = value;
}

/**
 * @private
 */
function evalTemplate(data, template) {
	const helpers = getHelpers();
	const helperNames = helpers.map(a => a.name);

	const validator = {
		get(target, key) {
			// console.log('key', key, {
			// 	target,
			// 	key,
			// 	obj: typeof target[key]
			// });
			if (typeof target[key] === 'object' && target[key] !== null) {
				return new Proxy(target[key], validator);
			} else {
				if (!Reflect.has(target, key)) {
					return '';
				}
				return target[key];
			}
		}
	};
	const proxyCtx = new Proxy(data, validator);

	try {
		const fn = new Function('ctx', ...helperNames, 'return `' + template + '`;');
		return fn.call(null, proxyCtx, ...helpers) || '';
	} catch (ex) {
		log(`error with template: ${template}`, ex);
		throw ex;
	}
}

/**
 * @private
 */
function evalCalculate(data, template, value) {
	const helpers = getHelpers();
	const helperNames = helpers.map(a => a.name);

	try {
		const fn = new Function(...helperNames, `return ${template}`);
		const result = fn.call(null, ...helpers)(data, value);

		if (typeof result !== 'object'
			|| result.field === undefined
			|| result.fill === undefined) {
			log('invalid calculate return value', template);
			throw new Error('calculate functions should return an object: { field, fill }');
		}

		return result;
	} catch (ex) {
		log(chalk.red(`error with template: ${template}`));
		throw ex;
	}
}

/**
 * @private
 */
function ensureNotUsingReservedKeys(inputs) {
	const RESERVED_KEYS = [
		'forms'
	];
	const keys = Object.keys(inputs);
	for (const key of keys) {
		if (RESERVED_KEYS.includes(key)) {
			throw new Error(`You cannot use a reserved key: ${key}`);
		}
	}
}

/**
 * @private
 */
async function loadYAML(filename) {
	if (typeof filename !== 'string') {
		// not a filename
		return filename;
	}
	await afs.access(filename, fs.constants.R_OK);
	return YAML.safeLoad(await afs.readFile(filename));
}

module.exports = Form;
