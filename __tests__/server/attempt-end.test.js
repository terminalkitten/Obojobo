jest.mock('../../../../insert_event')
jest.mock('../../../../models/draft')
jest.mock('../../../../routes/api/events/create_caliper_event')
jest.mock('../../../../logger')
jest.mock('../../../../config', () => ({
	db: {
		host: 'host',
		port: 'port',
		database: 'database',
		user: 'user',
		password: 'password'
	}
}))

jest.mock('../../../../lti', () => ({
	replaceResult: jest.fn(),
	sendHighestAssessmentScore: jest.fn()
}))
jest.mock('../../server/assessment-rubric')
jest.mock('../../server/assessment', () => ({
	getAttempt: jest.fn().mockResolvedValue({
		assessment_id: 'mockAssessmentId',
		attemptNumber: 'mockAttemptNumber',
		state: 'mockState',
		draft_id: 'mockDraftId'
	}),
	getAttempts: jest.fn().mockResolvedValue('attempts'),
	getAttemptNumber: jest.fn().mockResolvedValue(6),
	getResponsesForAttempt: jest.fn().mockResolvedValue('mockResponsesForAttempt'),
	getCompletedAssessmentAttemptHistory: jest.fn().mockReturnValue('super bat dad'),
	completeAttempt: jest.fn().mockReturnValue('mockCompleteAttemptResult'),
	updateAttempt: jest.fn(),
	updateAttemptState: jest.fn()
}))

jest.mock('uuid')

jest.mock('../../../../db', () => {
	return {
		one: jest.fn(),
		manyOrNone: jest.fn(),
		any: jest.fn(),
		none: jest.fn()
	}
})

const logger = oboRequire('logger')
const config = oboRequire('config')
const db = oboRequire('db')
const DraftModel = oboRequire('models/draft')
const Draft = oboRequire('models/draft')
const DraftNode = oboRequire('models/draft_node')
const lti = oboRequire('lti')
const insertEvent = oboRequire('insert_event')
const createCaliperEvent = oboRequire('routes/api/events/create_caliper_event') //@TODO
const originalToISOString = Date.prototype.toISOString
const AssessmentRubric = require('../../server/assessment-rubric')
import Assessment from '../../server/assessment'
import testJson from '../../test-object.json'

import {
	endAttempt,
	getAttempt,
	getAttemptHistory,
	getResponsesForAttempt,
	getCalculatedScores,
	calculateScores,
	completeAttempt,
	insertAttemptEndEvents,
	sendLTIHighestAssessmentScore,
	insertAttemptScoredEvents,
	sendLTIScore,
	getNodeQuestion,
	recreateChosenQuestionTree,
	reloadAttemptStateIfReviewing
} from '../../server/attempt-end'

describe('Attempt End', () => {
	const initMockUsedQuestionMap = map => {
		map.set('qb1', 0)
		map.set('qb1.q1', 0)
		map.set('qb1.q2', 0)
		map.set('qb2', 0)
		map.set('qb2.q1', 0)
		map.set('qb2.q2', 0)
	}

	beforeAll(() => {
		Date.prototype.toISOString = () => 'mockDate'
	})
	afterAll(() => {
		Date.prototype.toISOString = originalToISOString
	})

	beforeEach(() => {
		jest.restoreAllMocks()
		insertEvent.mockReset()
		AssessmentRubric.mockGetAssessmentScoreInfoForAttempt.mockReset()
		AssessmentRubric.mockGetAssessmentScoreInfoForAttempt.mockReturnValue('mockScoreForAttempt')
		lti.sendHighestAssessmentScore.mockReset()
	})

	test('endAttempt returns Assessment.getAttempts, sends lti highest score, and inserts 2 events', () => {
		// provide a draft model mock
		let draft = new DraftModel({ content: { rubric: 1 } })
		draft.yell.mockImplementationOnce(
			(eventType, req, res, assessmentModel, responseHistory, event) => {
				event.addScore('q1', 0)
				event.addScore('q2', 100)
				return [Promise.resolve()]
			}
		)
		draft.getChildNodeById.mockReturnValueOnce(draft)
		DraftModel.fetchById.mockResolvedValueOnce(draft)

		// Mock out assessment methods internally to build score data
		Assessment.getCompletedAssessmentAttemptHistory.mockResolvedValueOnce([])
		Assessment.getAttempt.mockResolvedValueOnce({
			assessment_id: 'mockAssessmentId',
			state: { questions: [] },
			draft_id: 'mockDraftId'
		})

		// mock the caliperEvent methods
		let createAssessmentAttemptSubmittedEvent = jest.fn().mockReturnValue('mockCaliperPayload')
		let createAssessmentAttemptScoredEvent = jest.fn().mockReturnValue('mockCaliperPayload')
		insertEvent.mockReturnValueOnce('mockInsertResult')
		createCaliperEvent
			.mockReturnValueOnce({ createAssessmentAttemptSubmittedEvent })
			.mockReturnValueOnce({ createAssessmentAttemptScoredEvent })

		// mock lti send score
		lti.sendHighestAssessmentScore.mockReturnValueOnce({
			scoreSent: 'mockScoreSent',
			error: 'mockScoreError',
			errorDetails: 'mockErrorDetails',
			ltiAssessmentScoreId: 'mockLitScoreId',
			status: 'mockStatus'
		})

		let req = { connection: { remoteAddress: 'mockRemoteAddress' } }
		let user = { id: 'mockUserId' }
		expect(insertEvent).toHaveBeenCalledTimes(0)

		return endAttempt(req, {}, user, 'mockAttemptId', true).then(results => {
			expect(logger.info).toHaveBeenCalledTimes(8)
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('getAttempt success'))
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('getAttemptHistory success'))
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('getCalculatedScores success')
			)
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('completeAttempt success'))
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('insertAttemptEndEvent success')
			)
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('sendLTIScore was executed'))

			expect(results).toBe('attempts')
			expect(lti.sendHighestAssessmentScore).toHaveBeenLastCalledWith(
				'mockUserId',
				'mockDraftId',
				'mockAssessmentId'
			)
			expect(insertEvent).toHaveBeenCalledTimes(2)
			expect(insertEvent).toHaveBeenCalledWith({
				action: 'assessment:attemptScored',
				actorTime: 'mockDate',
				caliperPayload: 'mockCaliperPayload',
				draftId: 'mockDraftId',
				eventVersion: '2.0.0',
				ip: 'mockRemoteAddress',
				metadata: {},
				payload: {
					assessmentScore: undefined,
					assessmentScoreId: undefined,
					attemptCount: 6,
					attemptId: 'mockAttemptId',
					attemptScore: undefined,
					ltiAssessmentScoreId: 'mockLitScoreId',
					ltiScoreError: 'mockScoreError',
					ltiScoreErrorDetails: 'mockErrorDetails',
					ltiScoreSent: 'mockScoreSent',
					ltiScoreStatus: 'mockStatus'
				},
				userId: 'mockUserId'
			})
			expect(insertEvent).toHaveBeenCalledWith({
				action: 'assessment:attemptEnd',
				actorTime: 'mockDate',
				caliperPayload: 'mockCaliperPayload',
				draftId: 'mockDraftId',
				eventVersion: '1.1.0',
				ip: 'mockRemoteAddress',
				metadata: {},
				payload: {
					attemptCount: 6,
					attemptId: 'mockAttemptId'
				},
				userId: 'mockUserId'
			})
		})
	})

	test('getAttempt returns an object of attempt info', () => {
		expect.assertions(6)

		return getAttempt(1).then(attempt => {
			expect(attempt).toHaveProperty('assessmentId', 'mockAssessmentId')
			expect(attempt).toHaveProperty('number', 6)
			expect(attempt).toHaveProperty('attemptState', 'mockState')
			expect(attempt).toHaveProperty('draftId', 'mockDraftId')
			expect(attempt).toHaveProperty('model', expect.any(DraftModel))
			expect(attempt).toHaveProperty('assessmentModel', 'mockChild')
		})
	})

	test('getAttemptHistory calls Assessment method', () => {
		let result = getAttemptHistory('userId', 'draftId', 'assessmentId')
		expect(Assessment.getCompletedAssessmentAttemptHistory).toHaveBeenLastCalledWith(
			'userId',
			'draftId',
			'assessmentId'
		)
		expect(result).toBe('super bat dad')
	})

	test('getCalculatedScores', () => {
		expect.assertions(4)
		// Setup: Assessment with two questions (q1 and q2)
		// First attempt: q1 = 60%, q2 = 100%, attempt = 80%
		// This attempt: q1 = 0%, q2 = 100%, attempt should be 50%
		// Result should be an assessment score of 80% (highest)
		// but this attempt should be a 50%

		let req = jest.fn()
		let res = jest.fn()
		let assessmentModel = {
			yell: (eventType, req, res, assessmentModel, responseHistory, event) => {
				expect(event).toHaveProperty('getQuestions', expect.any(Function))
				expect(event).toHaveProperty('addScore', expect.any(Function))
				expect(event.getQuestions()).toBe(attemptState.questions)

				// add scores into the method's scoreInfo object for calculating later
				// this is usually done by yell after getting the questions
				event.addScore('q1', 66.6666666667)
				event.addScore('q2', 12.9999999999)

				return [] // return empty array of promises, no need for more
			},
			node: { content: {} }
		}
		let attemptState = {
			questions: [
				{
					id: 'q1'
				},
				{
					id: 'q2'
				}
			]
		}
		let attemptHistory = []
		let responseHistory = jest.fn()

		return getCalculatedScores(
			req,
			res,
			assessmentModel,
			attemptState,
			attemptHistory,
			responseHistory
		).then(result => {
			expect(result).toEqual({
				assessmentScoreDetails: 'mockScoreForAttempt',
				attempt: {
					attemptScore: 39.8333333333,
					questionScores: [
						{
							id: 'q1',
							score: 66.6666666667
						},
						{
							id: 'q2',
							score: 12.9999999999
						}
					]
				}
			})
		})
	})

	test('insertAttemptEndEvents calls insertEvent with expected params (preview mode = true)', () => {
		// mock the caliperEvent method
		let createAssessmentAttemptSubmittedEvent = jest.fn().mockReturnValue('mockCaliperPayload')
		insertEvent.mockReturnValueOnce('mockInsertResult')
		createCaliperEvent.mockReturnValueOnce({
			createAssessmentAttemptSubmittedEvent
		})

		let r = insertAttemptEndEvents(
			{ id: 'mockUserId' },
			'mockDraftId',
			'mockAssessmentId',
			'mockAttemptId',
			'mockAttemptNumber',
			'mockIsPreviewing',
			'mockHostname',
			'mockRemoteAddress'
		)

		// make sure we get the result of insertEvent back
		expect(r).toBe('mockInsertResult')

		// make sure insert event is called
		expect(insertEvent).toHaveBeenCalledTimes(1)

		// make sure insert event is called with the arguments we expect
		expect(insertEvent).toHaveBeenCalledWith({
			action: 'assessment:attemptEnd',
			actorTime: 'mockDate',
			payload: {
				attemptId: 'mockAttemptId',
				attemptCount: 'mockAttemptNumber'
			},
			userId: 'mockUserId',
			ip: 'mockRemoteAddress',
			metadata: {},
			draftId: 'mockDraftId',
			eventVersion: '1.1.0',
			caliperPayload: 'mockCaliperPayload'
		})

		// make sure the caliper payload gets the expected inputs
		expect(createAssessmentAttemptSubmittedEvent).toHaveBeenCalledWith({
			actor: {
				id: 'mockUserId',
				type: 'user'
			},
			assessmentId: 'mockAssessmentId',
			attemptId: 'mockAttemptId',
			draftId: 'mockDraftId',
			isPreviewMode: 'mockIsPreviewing'
		})
	})

	test('insertAttemptScoredEvents calls insertEvent with expected params (preview mode = false, isScoreSent = false)', () => {
		// mock the caliperEvent method
		let createAssessmentAttemptScoredEvent = jest.fn().mockReturnValue('mockCaliperPayload')
		insertEvent.mockReturnValueOnce('mockInsertResult')
		createCaliperEvent.mockReturnValueOnce({
			createAssessmentAttemptScoredEvent
		})

		let r = insertAttemptScoredEvents(
			{ id: 'userId' },
			'mockDraftId',
			'mockAssessmentId',
			'mockAssessmentScoreId',
			'mockAttemptId',
			'mockAttemptNumber',
			'mockAttemptScore',
			'mockAssessmentScore',
			'mockIsPreviewing',
			'mockLtiScoreSent',
			'mockLtiScoreStatus',
			'mockLtiScoreError',
			'mockLtiScoreErrorDetails',
			'mockLtiAssessmentScoreId',
			'mockHostname',
			'mockRemoteAddress'
		)

		// make sure we get the result of insertEvent back
		expect(r).toBe('mockInsertResult')

		// make sure insert event is called
		expect(insertEvent).toHaveBeenCalledTimes(1)

		// make sure insert event is called with the arguments we expect
		expect(insertEvent).toHaveBeenCalledWith({
			action: 'assessment:attemptScored',
			actorTime: 'mockDate',
			caliperPayload: 'mockCaliperPayload',
			draftId: 'mockDraftId',
			eventVersion: '2.0.0',
			ip: 'mockRemoteAddress',
			metadata: {},
			payload: {
				assessmentScore: 'mockAssessmentScore',
				assessmentScoreId: 'mockAssessmentScoreId',
				attemptCount: 'mockAttemptNumber',
				attemptId: 'mockAttemptId',
				attemptScore: 'mockAttemptScore',
				ltiAssessmentScoreId: 'mockLtiAssessmentScoreId',
				ltiScoreError: 'mockLtiScoreError',
				ltiScoreErrorDetails: 'mockLtiScoreErrorDetails',
				ltiScoreSent: 'mockLtiScoreSent',
				ltiScoreStatus: 'mockLtiScoreStatus'
			},
			userId: 'userId'
		})

		// make sure the caliper payload gets the expected inputs
		expect(createAssessmentAttemptScoredEvent).toHaveBeenCalledWith({
			actor: {
				type: 'serverApp'
			},
			assessmentId: 'mockAssessmentId',
			attemptId: 'mockAttemptId',
			attemptScore: 'mockAttemptScore',
			draftId: 'mockDraftId',
			extensions: {
				assessmentScore: 'mockAssessmentScore',
				attemptCount: 'mockAttemptNumber',
				attemptScore: 'mockAttemptScore',
				ltiScoreSent: 'mockLtiScoreSent'
			},
			isPreviewMode: 'mockIsPreviewing'
		})
	})

	test('sendLTIHighestAssessmentScore calls lti.sendLTIHighestAssessmentScore', () => {
		expect(lti.sendHighestAssessmentScore).toHaveBeenCalledTimes(0)
		sendLTIHighestAssessmentScore()
		expect(lti.sendHighestAssessmentScore).toHaveBeenCalledTimes(1)
	})

	test('calculateScores keeps all scores in order', () => {
		let assessmentModel = { node: { content: {} } }

		let attemptHistory = [
			{
				result: {
					attemptScore: 25
				}
			}
		]

		let scoreInfo = {
			questions: [{ id: 4 }, { id: 5 }, { id: 6 }],
			scoresByQuestionId: { 4: 50, 5: 75, 6: 27 },
			scores: [50, 75, 27]
		}

		let result = calculateScores(assessmentModel, attemptHistory, scoreInfo)

		// make sure the questionScores are in the same order
		expect(result.attempt.questionScores).toEqual([
			{ id: 4, score: 50 },
			{ id: 5, score: 75 },
			{ id: 6, score: 27 }
		])
	})

	test('calculateScores calculates expected attemptScore', () => {
		let assessmentModel = { node: { content: {} } }

		let attemptHistory = [
			{
				result: {
					attemptScore: 25
				}
			}
		]

		let scoreInfo = {
			questions: [{ id: 4 }, { id: 5 }, { id: 6 }],
			scoresByQuestionId: { 4: 50, 5: 75, 6: 27 },
			scores: [50, 75, 27]
		}

		let result = calculateScores(assessmentModel, attemptHistory, scoreInfo)
		expect(result.attempt.attemptScore).toBe(50.666666666666664)
	})

	test('calculateScores calls AssessmentRubric.getAssessmentScoreInfoForAttempt with expected values', () => {
		expect(AssessmentRubric.mockGetAssessmentScoreInfoForAttempt).toHaveBeenCalledTimes(0)
		let assessmentModel = { node: { content: { attempts: 'mockContentAttempts' } } }

		let attemptHistory = [{ result: { attemptScore: 25 } }]

		let scoreInfo = {
			questions: [{ id: 4 }, { id: 5 }],
			scoresByQuestionId: { 4: 50, 5: 75 },
			scores: [50, 75]
		}

		let result = calculateScores(assessmentModel, attemptHistory, scoreInfo)

		expect(result).toHaveProperty('assessmentScoreDetails', 'mockScoreForAttempt')
		expect(AssessmentRubric.mockGetAssessmentScoreInfoForAttempt).toHaveBeenCalledTimes(1)
		expect(AssessmentRubric.mockGetAssessmentScoreInfoForAttempt).toHaveBeenCalledWith(
			'mockContentAttempts',
			[25, 62.5]
		)
	})

	test.skip('@TODO - Need to make sure that these tests log correct', () => {
		//Don't actually write this test - this is just a reminder
		//that we need to add log mocks to the other tests in this file
	})

	test('getCalculatedScores calls calculateScores with expected values', () => {
		let attemptHistory = [
			{
				result: {
					attemptScore: 25
				}
			}
		]

		let attemptState = {
			questions: [{ id: 4 }, { id: 5 }, { id: 6 }]
		}

		let x = new DraftModel({ content: { rubric: 1 } })

		// now we have to mock yell so that we can call addScore()
		x.yell.mockImplementationOnce((event, req, res, model, history, funcs) => {
			funcs.addScore(4, 10)
			funcs.addScore(5, 66)
			funcs.addScore(6, 77)
			return [Promise.resolve()]
		})

		return getCalculatedScores({}, {}, x, attemptState, attemptHistory, 'rh').then(result => {
			expect(result).toEqual({
				assessmentScoreDetails: 'mockScoreForAttempt',
				attempt: {
					attemptScore: 51,
					questionScores: [
						{
							id: 4,
							score: 10
						},
						{
							id: 5,
							score: 66
						},
						{
							id: 6,
							score: 77
						}
					]
				}
			})

			expect()
		})
	})

	test('completeAttempt calls Assessment.completeAttempt with expected values', () => {
		let r = completeAttempt(
			'mockAssessmentId',
			'mockAttemptId',
			'mockUserId',
			'mockDraftId',
			{ attempt: 'mockCalculatedScores', assessmentScoreDetails: 'mockScoreDeets' },
			'mockPreview'
		)

		// make sure we get the result of insertEvent back
		expect(r).toBe('mockCompleteAttemptResult')

		// make sure Assessment.completeAttempt is called
		expect(Assessment.completeAttempt).toHaveBeenLastCalledWith(
			'mockAssessmentId',
			'mockAttemptId',
			'mockUserId',
			'mockDraftId',
			'mockCalculatedScores',
			'mockScoreDeets',
			'mockPreview'
		)
	})

	test('insertAttemptEndEvents creates a correct caliper event and internal event', () => {
		// mock the caliperEvent method
		let createAssessmentAttemptSubmittedEvent = jest.fn().mockReturnValue('mockCaliperPayload')
		insertEvent.mockReturnValueOnce('mockInsertResult')
		createCaliperEvent.mockReturnValueOnce({
			createAssessmentAttemptSubmittedEvent
		})

		let r = insertAttemptEndEvents(
			{ id: 1 },
			'mockDraftId',
			'mockAssessmentId',
			'mockAttemptId',
			'mockAttemptNumber',
			'mockIsPreviewing',
			'mockHostname',
			'mockRemoteAddress'
		)

		// make sure we get the result of insertEvent back
		expect(r).toBe('mockInsertResult')

		// make sure insert event is called
		expect(insertEvent).toHaveBeenCalledTimes(1)

		// make sure insert event is called with the arguments we expect
		expect(insertEvent).toHaveBeenCalledWith({
			action: 'assessment:attemptEnd',
			actorTime: 'mockDate',
			caliperPayload: 'mockCaliperPayload',
			draftId: 'mockDraftId',
			eventVersion: '1.1.0',
			ip: 'mockRemoteAddress',
			metadata: {},
			payload: {
				attemptCount: 'mockAttemptNumber',
				attemptId: 'mockAttemptId'
			},
			userId: 1
		})
	})

	test.skip('getNodeQuestion reloads score', () => {
		const mockDraft = new Draft(testJson)
		const mockQuestion = {
			id: 'qb1.q1',
			type: 'ObojoboDraft.Chunks.Question',
			children: [
				{
					id: 'e3d455d5-80dd-4df8-87cf-594218016f44',
					type: 'ObojoboDraft.Chunks.Text',
					content: {},
					children: []
				},
				{
					id: 'qb1-q1-mca',
					type: 'ObojoboDraft.Chunks.MCAssessment',
					content: {},
					children: [
						{
							id: 'qb1-q1-mca-mc1',
							type: 'ObojoboDraft.Chunks.MCAssessment.MCChoice',
							content: { score: 0 }
						}
					]
				}
			]
		}

		expect(mockQuestion.id).toBe('qb1.q1')
		expect(mockQuestion.children[1].children[0].content.score).toBe(0)

		let reloadedQuestion = getNodeQuestion(mockQuestion.id, mockDraft)

		expect(reloadedQuestion.id).toBe(mockQuestion.id)
		expect(reloadedQuestion.children[1].children[0].content.score).toBe(100)
	})

	test.skip('recreateChosenQuestionTree parses down a one-level question bank', () => {
		const mockDraft = new Draft(testJson)
		const mockQB = {
			id: 'qb.lv1',
			type: 'ObojoboDraft.Chunks.QuestionBank',
			children: [
				{
					id: 'qb1.q1',
					type: 'ObojoboDraft.Chunks.Question',
					children: []
				}
			]
		}

		expect(mockQB.children.length).toBe(1)
		expect(mockQB.children[0].children.length).toBe(0)

		let traversedQB = recreateChosenQuestionTree(mockQB, mockDraft)

		expect(mockQB.children.length).toBe(1)
		expect(mockQB.children[0].children.length).not.toBe(0)
	})

	test.skip('recreateChosenQuestionTree parses down a multi-level question bank', () => {
		const mockDraft = new Draft(testJson)
		const mockQB = {
			id: 'qb.lv1',
			type: 'ObojoboDraft.Chunks.QuestionBank',
			children: [
				{
					id: 'qb.lv2',
					type: 'ObojoboDraft.Chunks.QuestionBank',
					children: [
						{
							id: 'qb.lv3',
							type: 'ObojoboDraft.Chunks.QuestionBank',
							children: [
								{
									id: 'qb1.q1',
									type: 'ObojoboDraft.Chunks.Question',
									children: []
								}
							]
						}
					]
				}
			]
		}

		expect(mockQB.children.length).toBe(1)
		expect(mockQB.children[0].children.length).toBe(1)
		expect(mockQB.children[0].children[0].children.length).toBe(1)
		expect(mockQB.children[0].children[0].children[0].children.length).toBe(0)

		let traversedQB = recreateChosenQuestionTree(mockQB, mockDraft)

		expect(mockQB.children.length).toBe(1)
		expect(mockQB.children[0].children.length).toBe(1)
		expect(mockQB.children[0].children[0].children.length).toBe(1)
		expect(mockQB.children[0].children[0].children[0].children.length).not.toBe(0)
	})

	test.skip('reloadAttemptStateIfReviewing does not reload when reviews are not allowed', () => {
		const mockProperties = {}
		const mockAttempt = {
			assessmentModel: {
				node: {
					content: {
						review: 'never'
					}
				}
			}
		}

		let response = reloadAttemptStateIfReviewing(0, 0, mockProperties, mockAttempt)

		expect(response).toBe(null)
	})

	test.skip('reloadAttemptStateIfReviewing does not reload when reviews are allowed after attempts, but it is not the last attempt', () => {
		const mockProperties = {}
		const mockAttempt = {
			number: 1,
			assessmentModel: {
				node: {
					content: {
						review: 'afterAttempts',
						attempts: 3
					}
				}
			}
		}

		let response = reloadAttemptStateIfReviewing(0, 0, mockProperties, mockAttempt)

		expect(response).toBe(null)
	})

	test.skip('reloadAttemptStateIfReviewing reloads only one when reviews are always allowed', () => {
		const mockDraft = new Draft(testJson)
		const assessmentNode = mockDraft.getChildNodeById('assessment')
		const assessmentQbTree = assessmentNode.children[1].toObject()
		const fakeChildNodes = [{ id: 'qb1.q1', children: [] }, { id: 'qb1.q2', children: [] }]
		const mockQbTree = { id: 'qb1', children: fakeChildNodes }

		const mockProperties = {
			draftTree: mockDraft,
			id: null,
			oboNode: assessmentNode,
			nodeChildrenIds: ['qb2', 'qb2.q1', 'qb2.q2'],
			assessmentQBTree: assessmentQbTree,
			attemptHistory: [
				{
					state: mockQbTree
				}
			],
			numAttemptsTaken: null,
			questionUsesMap: null
		}
		const mockAttempt = {
			number: 1,
			assessmentModel: {
				node: {
					content: {
						review: 'always',
						attempts: 3
					}
				}
			}
		}

		let response = reloadAttemptStateIfReviewing(0, 0, mockProperties, mockAttempt)

		expect(Assessment.updateAttemptState).toHaveBeenCalled()
	})

	test.skip('reloadAttemptStateIfReviewing reloads all when reviews are allowed after last', () => {
		const draft = new DraftModel({
			id: 'assessment',
			children: []
		})
		draft.getChildNodeById.mockReturnValueOnce(draft)
		const assessmentNode = draft.getChildNodeById('assessment')
		const assessmentQbTree = assessmentNode.children[1].toObject()
		const fakeChildNodes = [{ id: 'qb1.q1', children: [] }, { id: 'qb1.q2', children: [] }]
		const mockQbTree = { id: 'qb1', children: fakeChildNodes }

		const mockProperties = {
			user: { id: 0 },
			draftTree: draft,
			id: 0,
			oboNode: assessmentNode,
			nodeChildrenIds: ['qb2', 'qb2.q1', 'qb2.q2'],
			assessmentQBTree: assessmentQbTree,
			attemptHistory: [
				{
					state: mockQbTree
				}
			],
			numAttemptsTaken: null,
			questionUsesMap: null
		}
		const mockAttempt = {
			number: 3,
			assessmentModel: {
				node: {
					content: {
						review: 'afterAttempts',
						attempts: 3
					}
				}
			}
		}

		Assessment.getAttempts.mockImplementationOnce(() =>
			Promise.resolve({
				attempts: [
					{
						state: {
							qb: {
								id: 'qb.lv1',
								type: 'ObojoboDraft.Chunks.QuestionBank',
								children: [
									{
										id: 'qb.lv2',
										type: 'ObojoboDraft.Chunks.QuestionBank',
										children: [
											{
												id: 'qb.lv3',
												type: 'ObojoboDraft.Chunks.QuestionBank',
												children: [
													{
														id: 'qb1.q1',
														type: 'ObojoboDraft.Chunks.Question',
														children: []
													}
												]
											}
										]
									}
								]
							},
							questions: [{ id: 'qb1.q1' }]
						}
					}
				]
			})
		)

		let response = reloadAttemptStateIfReviewing(0, 0, mockProperties, mockAttempt)

		expect(Assessment.updateAttemptState).toHaveBeenCalled()
		expect(Assessment.getAttempts).toHaveBeenCalled()
	})
})
