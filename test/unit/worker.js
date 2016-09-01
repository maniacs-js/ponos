'use strict'

const chai = require('chai')
const joi = require('joi')
const monitor = require('monitor-dog')
const noop = require('101/noop')
const omit = require('101/omit')
const Promise = require('bluebird')
const sinon = require('sinon')
const WorkerStopError = require('error-cat/errors/worker-stop-error')
const assert = chai.assert
const TimeoutError = Promise.TimeoutError

const Worker = require('../../src/worker')
const logger = require('../../src/logger')

describe('Worker', () => {
  let opts
  beforeEach(() => {
    opts = {
      queue: 'do.something.command',
      task: (data) => { return Promise.resolve(data) },
      job: { message: 'hello world' },
      log: logger.child({ module: 'ponos:test' }),
      done: () => { return Promise.resolve() }
    }
  })

  describe('Constructor', () => {
    beforeEach(() => { sinon.stub(Worker.prototype, 'run') })

    afterEach(() => { Worker.prototype.run.restore() })

    it('should enforce default opts', () => {
      const testOpts = omit(opts, 'job')
      assert.throws(() => {
        Worker.create(testOpts)
      }, /"job" is required/)
    })

    it('should enforce default opts', () => {
      const testOpts = omit(opts, 'done')
      assert.throws(() => {
        Worker.create(testOpts)
      }, /"done" is required/)
    })

    it('should enforce default opts', () => {
      const testOpts = omit(opts, 'queue')
      assert.throws(() => {
        Worker.create(testOpts)
      }, /"queue" is required/)
    })

    it('should enforce default opts', () => {
      const testOpts = omit(opts, 'task')
      assert.throws(() => {
        Worker.create(testOpts)
      }, /"task" is required/)
    })

    it('should enforce default opts', () => {
      const testOpts = omit(opts, 'log')
      assert.throws(() => {
        Worker.create(testOpts)
      }, /"log" is required/)
    })

    it('should throw when jobSchema is not object', () => {
      opts.jobSchema = 'no schema'
      assert.throws(() => {
        Worker.create(opts)
      }, /"jobSchema" must be an object/)
    })

    it('should throw when jobSchema is not joi schema', () => {
      opts.jobSchema = {
        isJoi: false
      }
      assert.throws(() => {
        Worker.create(opts)
      }, /"isJoi" must be one of \[true\]/)
    })

    it('should default the timeout to not exist', () => {
      const w = Worker.create(opts)
      assert.equal(w.msTimeout, 0, 'set the timeout correctly')
    })

    it('should use the given logger', () => {
      const testLogger = {
        info: noop
      }
      const log = {
        child: () => { return testLogger }
      }
      opts.log = log
      const w = Worker.create(opts)
      assert.equal(w.log, testLogger)
    })

    it('should use the given errorCat', () => {
      opts.errorCat = { mew: 2 }
      const w = Worker.create(opts)
      assert.deepEqual(w.errorCat, { mew: 2 })
    })

    describe('with worker timeout', () => {
      let prevTimeout

      before(() => {
        prevTimeout = process.env.WORKER_TIMEOUT
        process.env.WORKER_TIMEOUT = 4000
      })

      after(() => { process.env.WORKER_TIMEOUT = prevTimeout })

      it('should use the environment timeout', () => {
        const w = Worker.create(opts)
        assert.equal(w.msTimeout, 4 * 1000, 'set the timeout correctly')
      })

      it('should throw when given a non-integer', () => {
        opts.msTimeout = 'foobar'
        assert.throws(() => {
          Worker.create(opts)
        }, /"msTimeout" must be a number/)
      })

      it('should throw when given a negative timeout', () => {
        opts.msTimeout = -230
        assert.throws(() => {
          Worker.create(opts)
        }, /must be larger than or equal to 0/)
      })
    })
  })

  describe('prototype methods', () => {
    let worker

    beforeEach(() => {
      worker = Worker.create(opts)
    })

    describe('_eventTags', () => {
      let worker
      const queue = 'some.queue.name'

      beforeEach(() => {
        worker = Worker.create(opts)
        worker.queue = queue
      })

      it('should generate tags for new style queues', () => {
        const tags = worker._eventTags()
        assert.isObject(tags)
        assert.equal(Object.keys(tags).length, 4)
        assert.deepEqual(tags, {
          queue: queue,
          token0: 'name',
          token1: 'queue.name',
          token2: 'some.queue.name'
        })
      })

      it('should generate tags for old style queues', () => {
        const queue = 'some-queue-name'
        worker.queue = queue
        const tags = worker._eventTags()
        assert.isObject(tags)
        assert.equal(Object.keys(tags).length, 2)
        assert.deepEqual(tags, {
          queue: queue,
          token0: 'some-queue-name'
        })
      })
    })

    describe('_incMonitor', () => {
      let worker
      const queue = 'do.something.command'

      beforeEach(() => {
        sinon.stub(monitor, 'increment')
        worker = Worker.create(opts)
        worker.queue = queue
      })

      afterEach(() => {
        monitor.increment.restore()
      })

      it('should call monitor increment for event without result tag', () => {
        worker._incMonitor('ponos')
        sinon.assert.calledOnce(monitor.increment)
        sinon.assert.calledWith(monitor.increment, 'ponos', {
          token0: 'command',
          token1: 'something.command',
          token2: 'do.something.command',
          queue: 'do.something.command'
        })
      })

      it('should call monitor increment for event with extra tags', () => {
        worker._incMonitor('ponos.finish', { result: 'success' })
        sinon.assert.calledOnce(monitor.increment)
        sinon.assert.calledWith(monitor.increment, 'ponos.finish', {
          token0: 'command',
          token1: 'something.command',
          token2: 'do.something.command',
          queue: 'do.something.command',
          result: 'success'
        })
      })

      describe('with disabled monitoring', () => {
        beforeEach(() => {
          process.env.WORKER_MONITOR_DISABLED = 'true'
        })

        afterEach(() => {
          delete process.env.WORKER_MONITOR_DISABLED
        })

        it('should not call monitor increment', () => {
          worker._incMonitor('ponos.finish', { result: 'success' })
          sinon.assert.notCalled(monitor.increment)
        })
      })
    })

    describe('_createTimer', () => {
      let worker
      const queue = 'do.something.command'

      beforeEach(() => {
        sinon.stub(monitor, 'timer').returns({ stop: () => {} })
        worker = Worker.create(opts)
        worker.queue = queue
      })

      afterEach(() => {
        monitor.timer.restore()
      })

      it('should call monitor.timer for event without result tag', () => {
        const timer = worker._createTimer()
        assert.isNotNull(timer)
        assert.isNotNull(timer.stop)
        sinon.assert.calledOnce(monitor.timer)
        sinon.assert.calledWith(monitor.timer, 'ponos.timer', true, {
          token0: 'command',
          token1: 'something.command',
          token2: 'do.something.command',
          queue: 'do.something.command'
        })
      })

      describe('with disabled monitoring', () => {
        beforeEach(() => {
          process.env.WORKER_MONITOR_DISABLED = 'true'
        })

        afterEach(() => {
          delete process.env.WORKER_MONITOR_DISABLED
        })

        it('should not call monitor.timer', () => {
          const timer = worker._createTimer()
          assert.isNull(timer)
          sinon.assert.notCalled(monitor.timer)
        })
      })
    })

    describe('_wrapTask', () => {
      beforeEach(() => {
        sinon.stub(worker, 'task')
      })

      afterEach(() => {
        worker.task.restore()
      })

      it('should timeout the job', () => {
        worker.msTimeout = 1
        worker.task.returns(() => {
          return Promise.delay(10000)
        })
        return assert.isRejected(worker._wrapTask(), TimeoutError)
          .then(() => {
            sinon.assert.calledOnce(worker.task)
          })
      })

      it('should not timeout the job', () => {
        worker.msTimeout = 1000000
        worker.task.returns(() => {
          return Promise.delay(1)
        })
        return assert.isFulfilled(worker._wrapTask())
          .then(() => {
            sinon.assert.calledOnce(worker.task)
          })
      })

      it('should run task', () => {
        const TestJob = { who: 'ami' }
        worker.job = TestJob
        return assert.isFulfilled(worker._wrapTask())
          .then(() => {
            sinon.assert.calledOnce(worker.task)
            sinon.assert.calledWith(worker.task, TestJob)
          })
      })
    }) // end _wrapTask

    describe('_validateJob', () => {
      it('should reject and not run if bad job', () => {
        worker.jobSchema = joi.string()
        worker.job = 123123
        return assert.isRejected(worker._validateJob(), WorkerStopError)
      })

      it('should run if valid schema', () => {
        worker.jobSchema = joi.string()
        worker.job = '123123'
        return assert.isFulfilled(worker._validateJob())
      })
    }) // end _validateJob

    describe('_addDataToError', () => {
      it('should make err cause if it has a cause', () => {
        const testError = {
          cause: new Error('Frodo')
        }
        try {
          worker._addDataToError(testError)
        } catch (err) {
          assert.deepEqual(err, testError.cause)
        }
      })

      it('should use passed error', () => {
        const testError = new Error('Gandalf')
        try {
          worker._addDataToError(testError)
        } catch (err) {
          assert.deepEqual(err, testError)
        }
      })

      it('should convert data to object', () => {
        const testError = new Error('Samwise')
        testError.data = 'string'
        try {
          worker._addDataToError(testError)
        } catch (err) {
          assert.isObject(err.data)
        }
      })

      it('should leave data alone', () => {
        const testError = new Error('Meriadoc')
        testError.data = {
          Merry: 'Brandybuck'
        }
        try {
          worker._addDataToError(testError)
        } catch (err) {
          assert.deepEqual(err, testError)
        }
      })

      it('should add queue', () => {
        const testError = new Error('Peregrin')
        worker.queue = 'Pippin'
        try {
          worker._addDataToError(testError)
        } catch (err) {
          assert.equal(err.data.queue, worker.queue)
        }
      })

      it('should leave queue alone', () => {
        const testError = new Error('Aragorn')
        worker.queue = 'Isildur'
        testError.data = {
          queue: 'Gondor'
        }
        try {
          worker._addDataToError(testError)
        } catch (err) {
          assert.equal(err.data.queue, testError.data.queue)
        }
      })

      it('should add job', () => {
        const testError = new Error('Peregrin')
        worker.job = 'Pippin'
        try {
          worker._addDataToError(testError)
        } catch (err) {
          assert.equal(err.data.job, worker.job)
        }
      })

      it('should leave job alone', () => {
        const testError = new Error('Aragorn')
        worker.job = 'Isildur'
        testError.data = {
          job: 'Gondor'
        }
        try {
          worker._addDataToError(testError)
        } catch (err) {
          assert.equal(err.data.job, testError.data.job)
        }
      })
    }) // end _addDataToError

    describe('_retryWithDelay', () => {
      beforeEach(() => {
        sinon.stub(worker, '_incMonitor').returns()
        sinon.stub(worker, 'run').resolves()
      })

      it('should _incMonitor', () => {
        return assert.isFulfilled(worker._retryWithDelay())
          .then(() => {
            sinon.assert.calledOnce(worker._incMonitor)
            sinon.assert.calledWith(worker._incMonitor, 'ponos.finish', {
              result: 'task-error'
            })
          })
      })

      it('should call after delay', () => {
        const clock = sinon.useFakeTimers()
        worker.retryDelay = 100
        return Promise.join([
          assert.isFulfilled(worker._retryWithDelay()),
          Promise.try(() => {
            sinon.assert.notCalled(worker.run)
            clock.tick(50)
            sinon.assert.notCalled(worker.run)
            clock.tick(50)
            sinon.assert.calledOnce(worker.run)
            clock.restore()
          })
        ])
      })

      it('should double delay', () => {
        worker.retryDelay = 1
        return assert.isFulfilled(worker._retryWithDelay())
          .then(() => {
            assert.equal(worker.retryDelay, 2)
          })
      })

      it('should not exceed max', () => {
        worker.retryDelay = 2
        worker.maxRetryDelay = 4
        return assert.isFulfilled(worker._retryWithDelay())
          .then(() => {
            return worker._retryWithDelay()
          })
          .then(() => {
            return worker._retryWithDelay()
          })
          .then(() => {
            assert.equal(worker.retryDelay, 4)
          })
      })
    }) // end _retryWithDelay

    describe('_enforceRetryLimit', () => {
      beforeEach(() => {
        sinon.stub(worker, '_incMonitor').returns()
        sinon.stub(worker, 'finalRetryFn').resolves()
      })

      it('should throw original error if limit not reached', () => {
        worker.attempt = 0
        worker.maxNumRetries = 5
        const testError = new Error('Legolas')
        return assert.isRejected(worker._enforceRetryLimit(testError), Error, /Legolas/)
          .then(() => {
            sinon.assert.notCalled(worker._incMonitor)
          })
      })

      it('should throw WorkerStopError error if limit reached', () => {
        worker.attempt = 10
        worker.maxNumRetries = 5
        const testError = new Error('Thranduil')
        return assert.isRejected(worker._enforceRetryLimit(testError), WorkerStopError, /final retry handler finished/)
          .then(() => {
            sinon.assert.calledOnce(worker._incMonitor)
            sinon.assert.calledWith(worker._incMonitor, 'ponos.finish-error', { result: 'retry-error' })
          })
      })

      it('should throw WorkerStopError error if finalRetryFn rejected', () => {
        worker.attempt = 10
        worker.maxNumRetries = 5
        const testError = new Error('Gimli')
        const retryError = new Error('Glóin')
        worker.finalRetryFn.rejects(retryError)
        return assert.isRejected(worker._enforceRetryLimit(testError), WorkerStopError, /final retry handler finished/)
          .then(() => {
            sinon.assert.calledTwice(worker._incMonitor)
            sinon.assert.calledWith(worker._incMonitor, 'ponos.finish-retry-fn-error', { result: 'retry-fn-error' })
            sinon.assert.calledWith(worker._incMonitor, 'ponos.finish-error', { result: 'retry-error' })
          })
      })

      it('should throw WorkerStopError error if finalRetryFn throws', () => {
        worker.attempt = 10
        worker.maxNumRetries = 5
        const testError = new Error('Boromir')
        const retryError = new Error('Denethor')
        worker.finalRetryFn.throws(retryError)
        return assert.isRejected(worker._enforceRetryLimit(testError), WorkerStopError, /final retry handler finished/)
          .then(() => {
            sinon.assert.calledTwice(worker._incMonitor)
            sinon.assert.calledWith(worker._incMonitor, 'ponos.finish-retry-fn-error', { result: 'retry-fn-error' })
            sinon.assert.calledWith(worker._incMonitor, 'ponos.finish-error', { result: 'retry-error' })
          })
      })
    }) // end _enforceRetryLimit

    describe('_handleWorkerStopError', () => {
      beforeEach(() => {
        sinon.stub(worker, '_incMonitor')
      })

      it('should monitor error', () => {
        worker._handleWorkerStopError()
        sinon.assert.calledOnce(worker._incMonitor)
        sinon.assert.calledWith(worker._incMonitor, 'ponos.finish-error', { result: 'fatal-error' })
      })
    }) // end _handleWorkerStopError

    describe('_handleTimeoutError', () => {
      beforeEach(() => {
        sinon.stub(worker, '_incMonitor')
      })

      it('should propagate and monitor error', () => {
        const testError = new Error('Sauron')
        assert.throws(() => {
          worker._handleTimeoutError(testError)
        }, Error, /Sauron/)
        sinon.assert.calledOnce(worker._incMonitor)
        sinon.assert.calledWith(worker._incMonitor, 'ponos.finish-error', { result: 'timeout-error' })
      })
    }) // end _handleTimeoutError

    describe('_handleTaskSuccess', () => {
      beforeEach(() => {
        sinon.stub(worker, '_incMonitor')
      })

      it('should monitor success', () => {
        worker._handleTaskSuccess()
        sinon.assert.calledOnce(worker._incMonitor)
        sinon.assert.calledWith(worker._incMonitor, 'ponos.finish', { result: 'success' })
      })
    }) // end _handleTaskSuccess

    describe('run', () => {
      let timerStub
      beforeEach(() => {
        timerStub = sinon.stub()
        sinon.stub(worker, '_createTimer').returns({
          stop: timerStub
        })
        sinon.stub(worker, '_wrapTask').resolves()
        sinon.stub(worker, '_handleTaskSuccess').resolves()
        sinon.stub(worker, '_addDataToError').resolves()
        sinon.stub(worker, '_handleTimeoutError').resolves()
        sinon.stub(worker, '_enforceRetryLimit').resolves()
        sinon.stub(worker.errorCat, 'report').resolves()
        sinon.stub(worker, '_handleWorkerStopError').resolves()
        sinon.stub(worker, '_retryWithDelay').resolves()
        sinon.stub(worker, 'done').resolves()
      })

      afterEach(() => {
        worker.errorCat.report.restore()
      })

      it('should not call error handlers on success', () => {
        return assert.isFulfilled(worker.run())
          .then(() => {
            sinon.assert.calledOnce(worker._createTimer)
            sinon.assert.calledOnce(worker._wrapTask)
            sinon.assert.calledOnce(worker._handleTaskSuccess)
            sinon.assert.notCalled(worker._addDataToError)
            sinon.assert.notCalled(worker._handleTimeoutError)
            sinon.assert.notCalled(worker._enforceRetryLimit)
            sinon.assert.notCalled(worker.errorCat.report)
            sinon.assert.notCalled(worker._handleWorkerStopError)
            sinon.assert.notCalled(worker._retryWithDelay)
            sinon.assert.calledOnce(worker.done)
            sinon.assert.calledOnce(timerStub)
          })
      })

      it('should call correct timeout handlers', () => {
        const timeoutError = new TimeoutError('Nazgûl')
        worker._wrapTask.rejects(timeoutError)
        worker._addDataToError.rejects(timeoutError)
        worker._handleTimeoutError.rejects(timeoutError)
        worker._enforceRetryLimit.rejects(timeoutError)
        worker.errorCat.report.rejects(timeoutError)

        return assert.isFulfilled(worker.run())
          .then(() => {
            sinon.assert.calledOnce(worker._createTimer)
            sinon.assert.calledOnce(worker._wrapTask)
            sinon.assert.notCalled(worker._handleTaskSuccess)
            sinon.assert.calledOnce(worker._addDataToError)
            sinon.assert.calledOnce(worker._handleTimeoutError)
            sinon.assert.calledOnce(worker._enforceRetryLimit)
            sinon.assert.calledOnce(worker.errorCat.report)
            sinon.assert.notCalled(worker._handleWorkerStopError)
            sinon.assert.calledOnce(worker._retryWithDelay)
            sinon.assert.calledOnce(worker.done)
            sinon.assert.calledOnce(timerStub)
          })
      })

      it('should call correct worker stop handlers', () => {
        const workerStopError = new WorkerStopError('Gollum')
        worker._wrapTask.rejects(workerStopError)
        worker._addDataToError.rejects(workerStopError)
        worker._handleTimeoutError.rejects(workerStopError)
        worker._enforceRetryLimit.rejects(workerStopError)
        worker.errorCat.report.rejects(workerStopError)

        return assert.isFulfilled(worker.run())
          .then(() => {
            sinon.assert.calledOnce(worker._createTimer)
            sinon.assert.calledOnce(worker._wrapTask)
            sinon.assert.notCalled(worker._handleTaskSuccess)
            sinon.assert.calledOnce(worker._addDataToError)
            sinon.assert.notCalled(worker._handleTimeoutError)
            sinon.assert.calledOnce(worker._enforceRetryLimit)
            sinon.assert.calledOnce(worker.errorCat.report)
            sinon.assert.calledOnce(worker._handleWorkerStopError)
            sinon.assert.notCalled(worker._retryWithDelay)
            sinon.assert.calledOnce(worker.done)
            sinon.assert.calledOnce(timerStub)
          })
      })

      it('should call correct error handlers', () => {
        const normalErr = new Error('Bilbo')
        worker._wrapTask.rejects(normalErr)
        worker._addDataToError.rejects(normalErr)
        worker._handleTimeoutError.rejects(normalErr)
        worker._enforceRetryLimit.rejects(normalErr)
        worker.errorCat.report.rejects(normalErr)

        return assert.isFulfilled(worker.run())
          .then(() => {
            sinon.assert.calledOnce(worker._createTimer)
            sinon.assert.calledOnce(worker._wrapTask)
            sinon.assert.notCalled(worker._handleTaskSuccess)
            sinon.assert.calledOnce(worker._addDataToError)
            sinon.assert.notCalled(worker._handleTimeoutError)
            sinon.assert.calledOnce(worker._enforceRetryLimit)
            sinon.assert.calledOnce(worker.errorCat.report)
            sinon.assert.notCalled(worker._handleWorkerStopError)
            sinon.assert.calledOnce(worker._retryWithDelay)
            sinon.assert.calledOnce(worker.done)
            sinon.assert.calledOnce(timerStub)
          })
      })
    }) // end run
  })
})
