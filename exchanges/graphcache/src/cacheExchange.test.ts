import {
  gql,
  createClient,
  ExchangeIO,
  Operation,
  OperationResult,
  CombinedError,
} from '@urql/core';

import { print, stripIgnoredCharacters } from 'graphql';
import { vi, expect, it, describe } from 'vitest';

import {
  Source,
  pipe,
  share,
  map,
  merge,
  mergeMap,
  filter,
  fromValue,
  makeSubject,
  tap,
  publish,
  delay,
} from 'wonka';

import { minifyIntrospectionQuery } from '@urql/introspection';
import { queryResponse } from '../../../packages/core/src/test-utils';
import { cacheExchange } from './cacheExchange';

const queryOne = gql`
  {
    author {
      id
      name
    }
    unrelated {
      id
    }
  }
`;

const queryOneData = {
  __typename: 'Query',
  author: {
    __typename: 'Author',
    id: '123',
    name: 'Author',
  },
  unrelated: {
    __typename: 'Unrelated',
    id: 'unrelated',
  },
};

const dispatchDebug = vi.fn();

describe('data dependencies', () => {
  it('writes queries to the cache', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const op = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
      variables: undefined,
    });

    const expected = {
      __typename: 'Query',
      author: {
        id: '123',
        name: 'Author',
        __typename: 'Author',
      },
      unrelated: {
        id: 'unrelated',
        __typename: 'Unrelated',
      },
    };

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      expect(forwardOp.key).toBe(op.key);
      return { ...queryResponse, operation: forwardOp, data: expected };
    });

    const { source: ops$, next } = makeSubject<Operation>();
    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(op);
    next(op);
    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(2);

    expect(expected).toMatchObject(result.mock.calls[0][0].data);
    expect(result.mock.calls[1][0]).toHaveProperty(
      'operation.context.meta.cacheOutcome',
      'hit'
    );
    expect(expected).toMatchObject(result.mock.calls[1][0].data);
    expect(result.mock.calls[1][0].data).toBe(result.mock.calls[0][0].data);
  });

  it('logs cache misses', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const op = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
      variables: undefined,
    });

    const expected = {
      __typename: 'Query',
      author: {
        id: '123',
        name: 'Author',
        __typename: 'Author',
      },
      unrelated: {
        id: 'unrelated',
        __typename: 'Unrelated',
      },
    };

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      expect(forwardOp.key).toBe(op.key);
      return { ...queryResponse, operation: forwardOp, data: expected };
    });

    const { source: ops$, next } = makeSubject<Operation>();
    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    const messages: string[] = [];
    pipe(
      cacheExchange({
        logger(severity, message) {
          if (severity === 'debug') {
            messages.push(message);
          }
        },
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(op);
    next(op);
    next({
      ...op,
      query: gql`
        query ($id: ID!) {
          author(id: $id) {
            id
            name
          }
        }
      `,
      variables: { id: '123' },
    });
    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(2);

    expect(expected).toMatchObject(result.mock.calls[0][0].data);
    expect(result.mock.calls[1][0]).toHaveProperty(
      'operation.context.meta.cacheOutcome',
      'hit'
    );
    expect(expected).toMatchObject(result.mock.calls[1][0].data);
    expect(result.mock.calls[1][0].data).toBe(result.mock.calls[0][0].data);
    expect(messages).toEqual([
      'No value for field "author" on entity "Query"',
      'No value for field "author" with args {"id":"123"} on entity "Query"',
    ]);
  });

  it('respects cache-only operations', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const op = client.createRequestOperation(
      'query',
      {
        key: 1,
        query: queryOne,
        variables: undefined,
      },
      {
        requestPolicy: 'cache-only',
      }
    );

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      expect(forwardOp.key).toBe(op.key);
      return { ...queryResponse, operation: forwardOp, data: queryOneData };
    });

    const { source: ops$, next } = makeSubject<Operation>();
    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(op);
    expect(response).toHaveBeenCalledTimes(0);
    expect(result).toHaveBeenCalledTimes(1);

    expect(result.mock.calls[0][0]).toHaveProperty(
      'operation.context.meta.cacheOutcome',
      'miss'
    );

    expect(result.mock.calls[0][0].data).toBe(null);
  });

  it('updates related queries when their data changes', () => {
    const queryMultiple = gql`
      {
        authors {
          id
          name
        }
      }
    `;

    const queryMultipleData = {
      __typename: 'Query',
      authors: [
        {
          __typename: 'Author',
          id: '123',
          name: 'New Author Name',
        },
      ],
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
      variables: undefined,
    });

    const opMultiple = client.createRequestOperation('query', {
      key: 2,
      query: queryMultiple,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: queryOneData };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: opMultiple,
          data: queryMultipleData,
        };
      }

      return undefined as any;
    });

    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);
    const result = vi.fn();

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(opOne);
    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);

    next(opMultiple);
    expect(response).toHaveBeenCalledTimes(2);
    expect(reexec.mock.calls[0][0]).toHaveProperty('key', opOne.key);
    expect(result).toHaveBeenCalledTimes(3);

    // test for reference reuse
    const firstDataOne = result.mock.calls[0][0].data;
    const firstDataTwo = result.mock.calls[1][0].data;
    expect(firstDataOne).not.toBe(firstDataTwo);
    expect(firstDataOne.author).not.toBe(firstDataTwo.author);
    expect(firstDataOne.unrelated).toBe(firstDataTwo.unrelated);
  });

  it('updates related queries when a mutation update touches query data', () => {
    vi.useFakeTimers();

    const balanceFragment = gql`
      fragment BalanceFragment on Author {
        id
        balance {
          amount
        }
      }
    `;

    const queryById = gql`
      query ($id: ID!) {
        author(id: $id) {
          id
          name
          ...BalanceFragment
        }
      }

      ${balanceFragment}
    `;

    const queryByIdDataA = {
      __typename: 'Query',
      author: {
        __typename: 'Author',
        id: '1',
        name: 'Author 1',
        balance: {
          __typename: 'Balance',
          amount: 100,
        },
      },
    };

    const queryByIdDataB = {
      __typename: 'Query',
      author: {
        __typename: 'Author',
        id: '2',
        name: 'Author 2',
        balance: {
          __typename: 'Balance',
          amount: 200,
        },
      },
    };

    const mutation = gql`
      mutation ($userId: ID!, $amount: Int!) {
        updateBalance(userId: $userId, amount: $amount) {
          userId
          balance {
            amount
          }
        }
      }
    `;

    const mutationData = {
      __typename: 'Mutation',
      updateBalance: {
        __typename: 'UpdateBalanceResult',
        userId: '1',
        balance: {
          __typename: 'Balance',
          amount: 1000,
        },
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: queryById,
      variables: { id: 1 },
    });

    const opTwo = client.createRequestOperation('query', {
      key: 2,
      query: queryById,
      variables: { id: 2 },
    });

    const opMutation = client.createRequestOperation('mutation', {
      key: 3,
      query: mutation,
      variables: { userId: '1', amount: 1000 },
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: queryByIdDataA };
      } else if (forwardOp.key === 2) {
        return { ...queryResponse, operation: opTwo, data: queryByIdDataB };
      } else if (forwardOp.key === 3) {
        return {
          ...queryResponse,
          operation: opMutation,
          data: mutationData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    const updates = {
      Mutation: {
        updateBalance: vi.fn((result, _args, cache) => {
          const {
            updateBalance: { userId, balance },
          } = result;
          cache.writeFragment(balanceFragment, { id: userId, balance });
        }),
      },
    };

    const keys = {
      Balance: () => null,
    };

    pipe(
      cacheExchange({ updates, keys })({ forward, client, dispatchDebug })(
        ops$
      ),
      tap(result),
      publish
    );

    next(opTwo);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(2);

    next(opMutation);
    vi.runAllTimers();

    expect(response).toHaveBeenCalledTimes(3);
    expect(updates.Mutation.updateBalance).toHaveBeenCalledTimes(1);

    expect(reexec).toHaveBeenCalledTimes(1);
    expect(reexec.mock.calls[0][0].key).toBe(1);

    expect(result.mock.calls[2][0]).toHaveProperty(
      'data.author.balance.amount',
      1000
    );
  });

  it('does not notify related queries when a mutation update does not change the data', () => {
    vi.useFakeTimers();

    const balanceFragment = gql`
      fragment BalanceFragment on Author {
        id
        balance {
          amount
        }
      }
    `;

    const queryById = gql`
      query ($id: ID!) {
        author(id: $id) {
          id
          name
          ...BalanceFragment
        }
      }

      ${balanceFragment}
    `;

    const queryByIdDataA = {
      __typename: 'Query',
      author: {
        __typename: 'Author',
        id: '1',
        name: 'Author 1',
        balance: {
          __typename: 'Balance',
          amount: 100,
        },
      },
    };

    const queryByIdDataB = {
      __typename: 'Query',
      author: {
        __typename: 'Author',
        id: '2',
        name: 'Author 2',
        balance: {
          __typename: 'Balance',
          amount: 200,
        },
      },
    };

    const mutation = gql`
      mutation ($userId: ID!, $amount: Int!) {
        updateBalance(userId: $userId, amount: $amount) {
          userId
          balance {
            amount
          }
        }
      }
    `;

    const mutationData = {
      __typename: 'Mutation',
      updateBalance: {
        __typename: 'UpdateBalanceResult',
        userId: '1',
        balance: {
          __typename: 'Balance',
          amount: 100,
        },
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: queryById,
      variables: { id: 1 },
    });

    const opTwo = client.createRequestOperation('query', {
      key: 2,
      query: queryById,
      variables: { id: 2 },
    });

    const opMutation = client.createRequestOperation('mutation', {
      key: 3,
      query: mutation,
      variables: { userId: '1', amount: 1000 },
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: queryByIdDataA };
      } else if (forwardOp.key === 2) {
        return { ...queryResponse, operation: opTwo, data: queryByIdDataB };
      } else if (forwardOp.key === 3) {
        return {
          ...queryResponse,
          operation: opMutation,
          data: mutationData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    const updates = {
      Mutation: {
        updateBalance: vi.fn((result, _args, cache) => {
          const {
            updateBalance: { userId, balance },
          } = result;
          cache.writeFragment(balanceFragment, { id: userId, balance });
        }),
      },
    };

    const keys = {
      Balance: () => null,
    };

    pipe(
      cacheExchange({ updates, keys })({ forward, client, dispatchDebug })(
        ops$
      ),
      tap(result),
      publish
    );

    next(opTwo);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(2);

    next(opMutation);
    vi.runAllTimers();

    expect(response).toHaveBeenCalledTimes(3);
    expect(updates.Mutation.updateBalance).toHaveBeenCalledTimes(1);

    expect(reexec).toHaveBeenCalledTimes(0);
  });

  it('does nothing when no related queries have changed', () => {
    const queryUnrelated = gql`
      {
        user {
          id
          name
        }
      }
    `;

    const queryUnrelatedData = {
      __typename: 'Query',
      user: {
        __typename: 'User',
        id: 'me',
        name: 'Me',
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();
    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
      variables: undefined,
    });
    const opUnrelated = client.createRequestOperation('query', {
      key: 2,
      query: queryUnrelated,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: queryOneData };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: opUnrelated,
          data: queryUnrelatedData,
        };
      }

      return undefined as any;
    });

    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);
    const result = vi.fn();

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(opOne);
    expect(response).toHaveBeenCalledTimes(1);

    next(opUnrelated);
    expect(response).toHaveBeenCalledTimes(2);

    expect(reexec).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledTimes(2);
  });

  it('does not reach updater when mutation has no selectionset in optimistic phase', () => {
    vi.useFakeTimers();

    const mutation = gql`
      mutation {
        concealAuthor
      }
    `;

    const mutationData = {
      __typename: 'Mutation',
      concealAuthor: true,
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    vi.spyOn(client, 'reexecuteOperation').mockImplementation(next);

    const opMutation = client.createRequestOperation('mutation', {
      key: 1,
      query: mutation,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return {
          ...queryResponse,
          operation: opMutation,
          data: mutationData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    const updates = {
      Mutation: {
        concealAuthor: vi.fn(),
      },
    };

    pipe(
      cacheExchange({ updates })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(opMutation);
    expect(updates.Mutation.concealAuthor).toHaveBeenCalledTimes(0);

    vi.runAllTimers();
    expect(updates.Mutation.concealAuthor).toHaveBeenCalledTimes(1);
  });

  it('does reach updater when mutation has no selectionset in optimistic phase with optimistic update', () => {
    vi.useFakeTimers();

    const mutation = gql`
      mutation {
        concealAuthor
      }
    `;

    const mutationData = {
      __typename: 'Mutation',
      concealAuthor: true,
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    vi.spyOn(client, 'reexecuteOperation').mockImplementation(next);

    const opMutation = client.createRequestOperation('mutation', {
      key: 1,
      query: mutation,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return {
          ...queryResponse,
          operation: opMutation,
          data: mutationData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    const updates = {
      Mutation: {
        concealAuthor: vi.fn(),
      },
    };

    const optimistic = {
      concealAuthor: vi.fn(() => true) as any,
    };

    pipe(
      cacheExchange({ updates, optimistic })({
        forward,
        client,
        dispatchDebug,
      })(ops$),
      tap(result),
      publish
    );

    next(opMutation);
    expect(optimistic.concealAuthor).toHaveBeenCalledTimes(1);
    expect(updates.Mutation.concealAuthor).toHaveBeenCalledTimes(1);

    vi.runAllTimers();
    expect(updates.Mutation.concealAuthor).toHaveBeenCalledTimes(2);
  });

  it('marks errored null fields as uncached but delivers them as expected', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const query = gql`
      {
        field
        author {
          id
        }
      }
    `;

    const operation = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const queryResult: OperationResult = {
      ...queryResponse,
      operation,
      data: {
        __typename: 'Query',
        field: 'test',
        author: null,
      },
      error: new CombinedError({
        graphQLErrors: [
          {
            message: 'Test',
            path: ['author'],
          },
        ],
      }),
    };

    const reexecuteOperation = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) return queryResult;
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(operation);

    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(reexecuteOperation).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0]).toHaveProperty('data.author', null);
  });

  it('mutation does not change number of reexecute request after a query', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });

    const { source: ops$, next: nextOp } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(nextOp);

    const mutation = gql`
      mutation {
        updateNode {
          __typename
          id
        }
      }
    `;

    const normalQuery = gql`
      {
        __typename
        item {
          __typename
          id
        }
      }
    `;

    const extendedQuery = gql`
      {
        __typename
        item {
          __typename
          extended: id
          extra @_optional
        }
      }
    `;

    const mutationOp = client.createRequestOperation('mutation', {
      key: 0,
      query: mutation,
      variables: undefined,
    });

    const normalOp = client.createRequestOperation(
      'query',
      {
        key: 1,
        query: normalQuery,
        variables: undefined,
      },
      {
        requestPolicy: 'cache-and-network',
      }
    );

    const extendedOp = client.createRequestOperation(
      'query',
      {
        key: 2,
        query: extendedQuery,
        variables: undefined,
      },
      {
        requestPolicy: 'cache-only',
      }
    );

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 0) {
        return {
          operation: mutationOp,
          data: {
            __typename: 'Mutation',
            updateNode: {
              __typename: 'Node',
              id: 'id',
            },
          },
          stale: false,
          hasNext: false,
        };
      } else if (forwardOp.key === 1) {
        return {
          operation: normalOp,
          data: {
            __typename: 'Query',
            item: {
              __typename: 'Node',
              id: 'id',
            },
          },
          stale: false,
          hasNext: false,
        };
      } else if (forwardOp.key === 2) {
        return {
          operation: extendedOp,
          data: {
            __typename: 'Query',
            item: {
              __typename: 'Node',
              extended: 'id',
              extra: 'extra',
            },
          },
          stale: false,
          hasNext: false,
        };
      }

      return undefined as any;
    });

    const forward = (ops$: Source<Operation>): Source<OperationResult> =>
      pipe(ops$, map(response), share);

    pipe(cacheExchange()({ forward, client, dispatchDebug })(ops$), publish);

    nextOp(normalOp);
    expect(reexec).toHaveBeenCalledTimes(0);

    nextOp(extendedOp);
    expect(reexec).toHaveBeenCalledTimes(0);

    // re-execute first operation
    reexec.mockClear();
    nextOp(normalOp);
    expect(reexec).toHaveBeenCalledTimes(4);

    nextOp(mutationOp);

    // re-execute first operation after mutation
    reexec.mockClear();
    nextOp(normalOp);
    expect(reexec).toHaveBeenCalledTimes(4);
  });
});

describe('directives', () => {
  it('returns optional fields as partial', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const query = gql`
      {
        todos {
          id
          text
          completed @_optional
        }
      }
    `;

    const operation = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const queryResult: OperationResult = {
      ...queryResponse,
      operation,
      data: {
        __typename: 'Query',
        todos: [
          {
            id: '1',
            text: 'learn urql',
            __typename: 'Todo',
          },
        ],
      },
    };

    const reexecuteOperation = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) return queryResult;
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(operation);

    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(reexecuteOperation).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0].data).toEqual({
      todos: [
        {
          completed: null,
          id: '1',
          text: 'learn urql',
        },
      ],
    });
  });

  it('Does not return partial data for nested selections', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const query = gql`
      {
        todo {
          ... on Todo @_optional {
            id
            text
            author {
              id
              name
            }
          }
        }
      }
    `;

    const operation = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const queryResult: OperationResult = {
      ...queryResponse,
      operation,
      data: {
        __typename: 'Query',
        todo: {
          id: '1',
          text: 'learn urql',
          __typename: 'Todo',
          author: {
            __typename: 'Author',
          },
        },
      },
    };

    const reexecuteOperation = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) return queryResult;
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(operation);

    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(reexecuteOperation).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0].data).toEqual(null);
  });

  it('returns partial results when an inline-fragment is marked as optional', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const query = gql`
      {
        todos {
          id
          text
          ... @_optional {
            ... on Todo {
              completed
            }
          }
        }
      }
    `;

    const operation = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const queryResult: OperationResult = {
      ...queryResponse,
      operation,
      data: {
        __typename: 'Query',
        todos: [
          {
            id: '1',
            text: 'learn urql',
            __typename: 'Todo',
          },
        ],
      },
    };

    const reexecuteOperation = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) return queryResult;
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(operation);

    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(reexecuteOperation).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0].data).toEqual({
      todos: [
        {
          completed: null,
          id: '1',
          text: 'learn urql',
        },
      ],
    });
  });

  it('does not return partial results when an inline-fragment is marked as optional with a required child fragment', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const query = gql`
      {
        todos {
          id
          ... on Todo @_optional {
            text
            ... on Todo @_required {
              completed
            }
          }
        }
      }
    `;

    const operation = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const queryResult: OperationResult = {
      ...queryResponse,
      operation,
      data: {
        __typename: 'Query',
        todos: [
          {
            id: '1',
            text: 'learn urql',
            __typename: 'Todo',
          },
        ],
      },
    };

    const reexecuteOperation = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) return queryResult;
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(operation);

    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(reexecuteOperation).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0].data).toEqual(null);
  });

  it('does not return partial results when an inline-fragment is marked as optional with a required field', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const query = gql`
      {
        todos {
          id
          ... on Todo @_optional {
            text
            completed @_required
          }
        }
      }
    `;

    const operation = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const queryResult: OperationResult = {
      ...queryResponse,
      operation,
      data: {
        __typename: 'Query',
        todos: [
          {
            id: '1',
            text: 'learn urql',
            __typename: 'Todo',
          },
        ],
      },
    };

    const reexecuteOperation = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) return queryResult;
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(operation);

    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(reexecuteOperation).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0].data).toEqual(null);
  });

  it('returns partial results when a fragment-definition is marked as optional', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const query = gql`
      {
        todos {
          id
          text
          ...Fields
        }
      }

      fragment Fields on Todo @_optional {
        completed
      }
    `;

    const operation = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const queryResult: OperationResult = {
      ...queryResponse,
      operation,
      data: {
        __typename: 'Query',
        todos: [
          {
            id: '1',
            text: 'learn urql',
            __typename: 'Todo',
          },
        ],
      },
    };

    const reexecuteOperation = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) return queryResult;
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(operation);

    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(reexecuteOperation).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0].data).toEqual(null);
  });

  it('does not return missing required fields', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const query = gql`
      {
        todos {
          id
          text
          completed @_required
        }
      }
    `;

    const operation = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const queryResult: OperationResult = {
      ...queryResponse,
      operation,
      data: {
        __typename: 'Query',
        todos: [
          {
            id: '1',
            text: 'learn urql',
            __typename: 'Todo',
          },
        ],
      },
    };

    const reexecuteOperation = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) return queryResult;
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(operation);

    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(
      stripIgnoredCharacters(print(response.mock.calls[0][0].query))
    ).toEqual('{todos{id text completed __typename}}');
    expect(reexecuteOperation).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0].data).toEqual(null);
  });

  it('does not return missing fields when nullable fields from a defined schema are marked as required in the query', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const initialQuery = gql`
      query {
        latestTodo {
          id
        }
      }
    `;

    const query = gql`
      {
        latestTodo {
          id
          author @_required {
            id
            name
          }
        }
      }
    `;

    const initialQueryOperation = client.createRequestOperation('query', {
      key: 1,
      query: initialQuery,
      variables: undefined,
    });

    const queryOperation = client.createRequestOperation('query', {
      key: 2,
      query,
      variables: undefined,
    });

    const initialQueryResult: OperationResult = {
      ...queryResponse,
      operation: initialQueryOperation,
      data: {
        __typename: 'Query',
        latestTodo: {
          __typename: 'Todo',
          id: '1',
        },
      },
    };

    const queryResult: OperationResult = {
      ...queryResponse,
      operation: queryOperation,
      data: {
        __typename: 'Query',
        latestTodo: {
          __typename: 'Todo',
          id: '1',
          author: null,
        },
      },
    };

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return initialQueryResult;
      } else if (forwardOp.key === 2) {
        return queryResult;
      }
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({
        schema: minifyIntrospectionQuery(
          // eslint-disable-next-line
          require('./test-utils/simple_schema.json')
        ),
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(initialQueryOperation);
    vi.runAllTimers();
    next(queryOperation);
    vi.runAllTimers();

    expect(result.mock.calls[0][0].data).toEqual({
      latestTodo: {
        id: '1',
      },
    });
    expect(result.mock.calls[1][0].data).toEqual(null);
  });
});

describe('optimistic updates', () => {
  it('writes optimistic mutations to the cache', () => {
    vi.useFakeTimers();

    const mutation = gql`
      mutation {
        concealAuthor {
          id
          name
        }
      }
    `;

    const optimisticMutationData = {
      __typename: 'Mutation',
      concealAuthor: {
        __typename: 'Author',
        id: '123',
        name() {
          return '[REDACTED OFFLINE]';
        },
      },
    };

    const mutationData = {
      __typename: 'Mutation',
      concealAuthor: {
        __typename: 'Author',
        id: '123',
        name: '[REDACTED ONLINE]',
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
      variables: undefined,
    });

    const opMutation = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: queryOneData };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: opMutation,
          data: mutationData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    const optimistic = {
      concealAuthor: vi.fn(() => optimisticMutationData.concealAuthor) as any,
    };

    pipe(
      cacheExchange({ optimistic })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);

    next(opMutation);
    expect(response).toHaveBeenCalledTimes(1);
    expect(optimistic.concealAuthor).toHaveBeenCalledTimes(1);
    expect(reexec).toHaveBeenCalledTimes(1);

    expect(result.mock.calls[1][0]?.data).toMatchObject({
      author: { name: '[REDACTED OFFLINE]' },
    });

    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(4);
  });

  it('batches optimistic mutation result application', () => {
    vi.useFakeTimers();

    const mutation = gql`
      mutation {
        concealAuthor {
          id
          name
        }
      }
    `;

    const optimisticMutationData = {
      __typename: 'Mutation',
      concealAuthor: {
        __typename: 'Author',
        id: '123',
        name: '[REDACTED OFFLINE]',
      },
    };

    const mutationData = {
      __typename: 'Mutation',
      concealAuthor: {
        __typename: 'Author',
        id: '123',
        name: '[REDACTED ONLINE]',
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
      variables: undefined,
    });

    const opMutationOne = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    const opMutationTwo = client.createRequestOperation('mutation', {
      key: 3,
      query: mutation,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: queryOneData };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: opMutationOne,
          data: mutationData,
        };
      } else if (forwardOp.key === 3) {
        return {
          ...queryResponse,
          operation: opMutationTwo,
          data: mutationData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(3), map(response), share);

    const optimistic = {
      concealAuthor: vi.fn(() => optimisticMutationData.concealAuthor) as any,
    };

    pipe(
      cacheExchange({ optimistic })({ forward, client, dispatchDebug })(ops$),
      filter(x => x.operation.kind === 'mutation'),
      tap(result),
      publish
    );

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(0);

    next(opMutationOne);
    vi.advanceTimersByTime(1);
    next(opMutationTwo);

    expect(response).toHaveBeenCalledTimes(1);
    expect(optimistic.concealAuthor).toHaveBeenCalledTimes(2);
    expect(reexec).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(2);
    expect(response).toHaveBeenCalledTimes(2);
    expect(reexec).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(1);

    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(3);
    expect(reexec).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(2);
  });

  it('blocks refetches of overlapping queries', () => {
    vi.useFakeTimers();

    const mutation = gql`
      mutation {
        concealAuthor {
          id
          name
        }
      }
    `;

    const optimisticMutationData = {
      __typename: 'Mutation',
      concealAuthor: {
        __typename: 'Author',
        id: '123',
        name: '[REDACTED OFFLINE]',
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation(
      'query',
      {
        key: 1,
        query: queryOne,
        variables: undefined,
      },
      {
        requestPolicy: 'cache-and-network',
      }
    );

    const opMutation = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: queryOneData };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(
        ops$,
        delay(1),
        filter(x => x.kind !== 'mutation'),
        map(response),
        share
      );

    const optimistic = {
      concealAuthor: vi.fn(() => optimisticMutationData.concealAuthor) as any,
    };

    pipe(
      cacheExchange({ optimistic })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);

    next(opMutation);
    expect(response).toHaveBeenCalledTimes(1);
    expect(optimistic.concealAuthor).toHaveBeenCalledTimes(1);
    expect(reexec).toHaveBeenCalledTimes(1);

    expect(reexec.mock.calls[0][0]).toHaveProperty(
      'context.requestPolicy',
      'cache-first'
    );

    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);

    next(opOne);
    expect(response).toHaveBeenCalledTimes(1);
    expect(reexec).toHaveBeenCalledTimes(1);
  });

  it('correctly clears on error', () => {
    vi.useFakeTimers();

    const authorsQuery = gql`
      query {
        authors {
          id
          name
        }
      }
    `;

    const authorsQueryData = {
      __typename: 'Query',
      authors: [
        {
          __typename: 'Author',
          id: '1',
          name: 'Author',
        },
      ],
    };

    const mutation = gql`
      mutation {
        addAuthor {
          id
          name
        }
      }
    `;

    const optimisticMutationData = {
      __typename: 'Mutation',
      addAuthor: {
        __typename: 'Author',
        id: '123',
        name: '[REDACTED OFFLINE]',
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: authorsQuery,
      variables: undefined,
    });

    const opMutation = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: authorsQueryData };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: opMutation,
          error: 'error' as any,
          data: { __typename: 'Mutation', addAuthor: null },
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    const optimistic = {
      addAuthor: vi.fn(() => optimisticMutationData.addAuthor) as any,
    };

    const updates = {
      Mutation: {
        addAuthor: vi.fn((data, _, cache) => {
          cache.updateQuery({ query: authorsQuery }, (prevData: any) => ({
            ...prevData,
            authors: [...prevData.authors, data.addAuthor],
          }));
        }),
      },
    };

    pipe(
      cacheExchange({ optimistic, updates })({
        forward,
        client,
        dispatchDebug,
      })(ops$),
      tap(result),
      publish
    );

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);

    next(opMutation);
    expect(response).toHaveBeenCalledTimes(1);
    expect(optimistic.addAuthor).toHaveBeenCalledTimes(1);
    expect(updates.Mutation.addAuthor).toHaveBeenCalledTimes(1);
    expect(reexec).toHaveBeenCalledTimes(1);

    vi.runAllTimers();

    expect(updates.Mutation.addAuthor).toHaveBeenCalledTimes(2);
    expect(response).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(4);
    expect(reexec).toHaveBeenCalledTimes(2);

    next(opOne);
    vi.runAllTimers();
    expect(result).toHaveBeenCalledTimes(5);
  });

  it('does not block subsequent query operations', () => {
    vi.useFakeTimers();

    const authorsQuery = gql`
      query {
        authors {
          id
          name
        }
      }
    `;

    const authorsQueryData = {
      __typename: 'Query',
      authors: [
        {
          __typename: 'Author',
          id: '123',
          name: 'Author',
        },
      ],
    };

    const mutation = gql`
      mutation {
        deleteAuthor {
          id
          name
        }
      }
    `;

    const optimisticMutationData = {
      __typename: 'Mutation',
      deleteAuthor: {
        __typename: 'Author',
        id: '123',
        name: '[REDACTED OFFLINE]',
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: authorsQuery,
      variables: undefined,
    });

    const opMutation = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: authorsQueryData };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: opMutation,
          data: {
            __typename: 'Mutation',
            deleteAuthor: optimisticMutationData.deleteAuthor,
          },
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    const optimistic = {
      deleteAuthor: vi.fn(() => optimisticMutationData.deleteAuthor) as any,
    };

    const updates = {
      Mutation: {
        deleteAuthor: vi.fn((_data, _, cache) => {
          cache.invalidate({
            __typename: 'Author',
            id: optimisticMutationData.deleteAuthor.id,
          });
        }),
      },
    };

    pipe(
      cacheExchange({ optimistic, updates })({
        forward,
        client,
        dispatchDebug,
      })(ops$),
      tap(result),
      publish
    );

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);

    next(opMutation);
    expect(response).toHaveBeenCalledTimes(1);
    expect(optimistic.deleteAuthor).toHaveBeenCalledTimes(1);
    expect(updates.Mutation.deleteAuthor).toHaveBeenCalledTimes(1);
    expect(reexec).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);

    vi.runAllTimers();

    expect(updates.Mutation.deleteAuthor).toHaveBeenCalledTimes(2);
    expect(response).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(2);
    expect(reexec).toHaveBeenCalledTimes(2);
    expect(reexec.mock.calls[1][0]).toMatchObject(opOne);

    next(opOne);
    vi.runAllTimers();
    expect(result).toHaveBeenCalledTimes(3);
  });
});

describe('mutation updates', () => {
  it('invalidates the type when the entity is not present in the cache', () => {
    vi.useFakeTimers();

    const authorsQuery = gql`
      query {
        authors {
          id
          name
        }
      }
    `;

    const authorsQueryData = {
      __typename: 'Query',
      authors: [
        {
          __typename: 'Author',
          id: '1',
          name: 'Author',
        },
      ],
    };

    const mutation = gql`
      mutation {
        addAuthor {
          id
          name
        }
      }
    `;

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(next);

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: authorsQuery,
      variables: undefined,
    });

    const opMutation = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: authorsQueryData };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: opMutation,
          data: {
            __typename: 'Mutation',
            addAuthor: { id: '2', name: 'Author 2', __typename: 'Author' },
          },
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    pipe(
      cacheExchange()({
        forward,
        client,
        dispatchDebug,
      })(ops$),
      tap(result),
      publish
    );

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);

    next(opMutation);
    expect(response).toHaveBeenCalledTimes(1);
    expect(reexec).toHaveBeenCalledTimes(0);

    vi.runAllTimers();

    expect(response).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(2);
    expect(reexec).toHaveBeenCalledTimes(1);

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(3);
    expect(result).toHaveBeenCalledTimes(3);
    expect(result.mock.calls[1][0].data).toEqual({
      addAuthor: {
        id: '2',
        name: 'Author 2',
      },
    });
  });
});

describe('extra variables', () => {
  it('allows extra variables to be applied to updates', () => {
    vi.useFakeTimers();

    const mutation = gql`
      mutation TestMutation($test: Boolean) {
        test(test: $test) {
          id
        }
      }
    `;

    const mutationData = {
      __typename: 'Mutation',
      test: {
        __typename: 'Author',
        id: '123',
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });

    const { source: ops$, next } = makeSubject<Operation>();

    const opQuery = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
      variables: undefined,
    });

    const opMutation = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: {
        test: true,
        extra: 'extra',
      },
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: forwardOp, data: queryOneData };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: forwardOp,
          data: mutationData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(3), map(response), share);

    const optimistic = {
      test: vi.fn() as any,
    };

    const updates = {
      Mutation: {
        test: vi.fn() as any,
      },
    };

    pipe(
      cacheExchange({ optimistic, updates })({
        forward,
        client,
        dispatchDebug,
      })(ops$),
      filter(x => x.operation.kind === 'mutation'),
      tap(result),
      publish
    );

    next(opQuery);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(0);

    next(opMutation);
    vi.advanceTimersByTime(1);

    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(0);
    expect(optimistic.test).toHaveBeenCalledTimes(1);

    expect(optimistic.test.mock.calls[0][2].variables).toEqual({
      test: true,
      extra: 'extra',
    });

    vi.runAllTimers();

    expect(response).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(1);
    expect(updates.Mutation.test).toHaveBeenCalledTimes(2);

    expect(updates.Mutation.test.mock.calls[1][3].variables).toEqual({
      test: true,
      extra: 'extra',
    });
  });
});

describe('custom resolvers', () => {
  it('follows resolvers on initial write', () => {
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: queryOneData };
      }

      return undefined as any;
    });

    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    const result = vi.fn();
    const fakeResolver = vi.fn();

    pipe(
      cacheExchange({
        resolvers: {
          Author: {
            name: () => {
              fakeResolver();
              return 'newName';
            },
          },
        },
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(opOne);
    expect(response).toHaveBeenCalledTimes(1);
    expect(fakeResolver).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(result.mock.calls[0][0].data).toMatchObject({
      author: {
        id: '123',
        name: 'newName',
      },
    });
  });

  it('follows resolvers for mutations', () => {
    vi.useFakeTimers();

    const mutation = gql`
      mutation {
        concealAuthor {
          id
          name
          __typename
        }
      }
    `;

    const mutationData = {
      __typename: 'Mutation',
      concealAuthor: {
        __typename: 'Author',
        id: '123',
        name: '[REDACTED ONLINE]',
      },
    };

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const opOne = client.createRequestOperation('query', {
      key: 1,
      query: queryOne,
      variables: undefined,
    });

    const opMutation = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return { ...queryResponse, operation: opOne, data: queryOneData };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: opMutation,
          data: mutationData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    const fakeResolver = vi.fn();

    pipe(
      cacheExchange({
        resolvers: {
          Author: {
            name: () => {
              fakeResolver();
              return 'newName';
            },
          },
        },
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(opOne);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);

    next(opMutation);
    expect(response).toHaveBeenCalledTimes(1);
    expect(fakeResolver).toHaveBeenCalledTimes(1);

    vi.runAllTimers();
    expect(result.mock.calls[1][0].data).toEqual({
      concealAuthor: {
        __typename: 'Author',
        id: '123',
        name: 'newName',
      },
    });
  });

  it('follows nested resolvers for mutations', () => {
    vi.useFakeTimers();

    const mutation = gql`
      mutation {
        concealAuthors {
          id
          name
          book {
            id
            title
            __typename
          }
          __typename
        }
      }
    `;

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();

    const query = gql`
      query {
        authors {
          id
          name
          book {
            id
            title
            __typename
          }
          __typename
        }
      }
    `;

    const queryOperation = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const mutationOperation = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    const mutationData = {
      __typename: 'Mutation',
      concealAuthors: [
        {
          __typename: 'Author',
          id: '123',
          book: null,
          name: '[REDACTED ONLINE]',
        },
        {
          __typename: 'Author',
          id: '456',
          name: 'Formidable',
          book: {
            id: '1',
            title: 'AwesomeGQL',
            __typename: 'Book',
          },
        },
      ],
    };

    const queryData = {
      __typename: 'Query',
      authors: [
        {
          __typename: 'Author',
          id: '123',
          name: '[REDACTED ONLINE]',
          book: null,
        },
        {
          __typename: 'Author',
          id: '456',
          name: 'Formidable',
          book: {
            id: '1',
            title: 'AwesomeGQL',
            __typename: 'Book',
          },
        },
      ],
    };

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return {
          ...queryResponse,
          operation: queryOperation,
          data: queryData,
        };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: mutationOperation,
          data: mutationData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    const fakeResolver = vi.fn();
    const called: any[] = [];

    pipe(
      cacheExchange({
        resolvers: {
          Query: {
            // TS-check
            author: (_parent, args) => ({ __typename: 'Author', id: args.id }),
          },
          Author: {
            name: parent => {
              called.push(parent.name);
              fakeResolver();
              return 'Secret Author';
            },
          },
          Book: {
            title: parent => {
              called.push(parent.title);
              fakeResolver();
              return 'Secret Book';
            },
          },
        },
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(queryOperation);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);
    expect(fakeResolver).toHaveBeenCalledTimes(3);

    next(mutationOperation);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(2);
    expect(fakeResolver).toHaveBeenCalledTimes(6);
    expect(result.mock.calls[1][0].data).toEqual({
      concealAuthors: [
        {
          __typename: 'Author',
          id: '123',
          book: null,
          name: 'Secret Author',
        },
        {
          __typename: 'Author',
          id: '456',
          name: 'Secret Author',
          book: {
            id: '1',
            title: 'Secret Book',
            __typename: 'Book',
          },
        },
      ],
    });

    expect(called).toEqual([
      // Query
      '[REDACTED ONLINE]',
      'Formidable',
      'AwesomeGQL',
      // Mutation
      '[REDACTED ONLINE]',
      'Formidable',
      'AwesomeGQL',
    ]);
  });
});

describe('schema awareness', () => {
  it('reexecutes query and returns data on partial result', () => {
    vi.useFakeTimers();
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();
    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      // Empty mock to avoid going in an endless loop, since we would again return
      // partial data.
      .mockImplementation(() => undefined);

    const initialQuery = gql`
      query {
        todos {
          id
          text
          __typename
        }
      }
    `;

    const query = gql`
      query {
        todos {
          id
          text
          complete
          author {
            id
            name
            __typename
          }
          __typename
        }
      }
    `;

    const initialQueryOperation = client.createRequestOperation('query', {
      key: 1,
      query: initialQuery,
      variables: undefined,
    });

    const queryOperation = client.createRequestOperation('query', {
      key: 2,
      query,
      variables: undefined,
    });

    const queryData = {
      __typename: 'Query',
      todos: [
        {
          __typename: 'Todo',
          id: '123',
          text: 'Learn',
        },
        {
          __typename: 'Todo',
          id: '456',
          text: 'Teach',
        },
      ],
    };

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return {
          ...queryResponse,
          operation: initialQueryOperation,
          data: queryData,
        };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: queryOperation,
          data: queryData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    pipe(
      cacheExchange({
        schema: minifyIntrospectionQuery(
          // eslint-disable-next-line
          require('./test-utils/simple_schema.json')
        ),
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(initialQueryOperation);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);
    expect(reexec).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0].data).toMatchObject({
      todos: [
        {
          __typename: 'Todo',
          id: '123',
          text: 'Learn',
        },
        {
          __typename: 'Todo',
          id: '456',
          text: 'Teach',
        },
      ],
    });

    next(queryOperation);
    vi.runAllTimers();
    expect(result).toHaveBeenCalledTimes(2);
    expect(reexec).toHaveBeenCalledTimes(1);
    expect(result.mock.calls[1][0].stale).toBe(true);
    expect(result.mock.calls[1][0].data).toEqual({
      todos: [
        {
          __typename: 'Todo',
          author: null,
          complete: null,
          id: '123',
          text: 'Learn',
        },
        {
          __typename: 'Todo',
          author: null,
          complete: null,
          id: '456',
          text: 'Teach',
        },
      ],
    });

    expect(result.mock.calls[1][0]).toHaveProperty(
      'operation.context.meta.cacheOutcome',
      'partial'
    );
  });

  it('reexecutes query and returns data on partial results for nullable lists', () => {
    vi.useFakeTimers();
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();
    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      // Empty mock to avoid going in an endless loop, since we would again return
      // partial data.
      .mockImplementation(() => undefined);

    const initialQuery = gql`
      query {
        todos {
          id
          __typename
        }
      }
    `;

    const query = gql`
      query {
        todos {
          id
          text
          __typename
        }
      }
    `;

    const initialQueryOperation = client.createRequestOperation('query', {
      key: 1,
      query: initialQuery,
      variables: undefined,
    });

    const queryOperation = client.createRequestOperation('query', {
      key: 2,
      query,
      variables: undefined,
    });

    const queryData = {
      __typename: 'Query',
      todos: [
        {
          __typename: 'Todo',
          id: '123',
        },
        {
          __typename: 'Todo',
          id: '456',
        },
      ],
    };

    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) {
        return {
          ...queryResponse,
          operation: initialQueryOperation,
          data: queryData,
        };
      } else if (forwardOp.key === 2) {
        return {
          ...queryResponse,
          operation: queryOperation,
          data: queryData,
        };
      }

      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ =>
      pipe(ops$, delay(1), map(response), share);

    pipe(
      cacheExchange({
        schema: minifyIntrospectionQuery(
          // eslint-disable-next-line
          require('./test-utils/simple_schema.json')
        ),
      })({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(initialQueryOperation);
    vi.runAllTimers();
    expect(response).toHaveBeenCalledTimes(1);
    expect(reexec).toHaveBeenCalledTimes(0);
    expect(result.mock.calls[0][0].data).toMatchObject({
      todos: [
        {
          __typename: 'Todo',
          id: '123',
        },
        {
          __typename: 'Todo',
          id: '456',
        },
      ],
    });

    next(queryOperation);
    vi.runAllTimers();
    expect(result).toHaveBeenCalledTimes(2);
    expect(reexec).toHaveBeenCalledTimes(1);
    expect(result.mock.calls[1][0].stale).toBe(true);
    expect(result.mock.calls[1][0].data).toEqual({
      todos: [null, null],
    });

    expect(result.mock.calls[1][0]).toHaveProperty(
      'operation.context.meta.cacheOutcome',
      'partial'
    );
  });
});

describe('looping protection', () => {
  it('applies stale to blocked looping queries', () => {
    let normalData: OperationResult | undefined;
    let extendedData: OperationResult | undefined;

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });

    const { source: ops$, next: nextOp } = makeSubject<Operation>();
    const { source: res$, next: nextRes } = makeSubject<OperationResult>();

    vi.spyOn(client, 'reexecuteOperation').mockImplementation(nextOp);

    const normalQuery = gql`
      {
        __typename
        item {
          __typename
          id
        }
      }
    `;

    const extendedQuery = gql`
      {
        __typename
        item {
          __typename
          extended: id
          extra @_optional
        }
      }
    `;

    const forward = (ops$: Source<Operation>): Source<OperationResult> =>
      share(
        merge([
          pipe(
            ops$,
            filter(() => false)
          ) as any,
          res$,
        ])
      );

    pipe(
      cacheExchange()({ forward, client, dispatchDebug })(ops$),
      tap(result => {
        if (result.operation.kind === 'query') {
          if (result.operation.key === 1) {
            normalData = result;
          } else if (result.operation.key === 2) {
            extendedData = result;
          }
        }
      }),
      publish
    );

    const normalOp = client.createRequestOperation(
      'query',
      {
        key: 1,
        query: normalQuery,
        variables: undefined,
      },
      {
        requestPolicy: 'cache-first',
      }
    );

    const extendedOp = client.createRequestOperation(
      'query',
      {
        key: 2,
        query: extendedQuery,
        variables: undefined,
      },
      {
        requestPolicy: 'cache-first',
      }
    );

    nextOp(normalOp);

    nextRes({
      operation: normalOp,
      data: {
        __typename: 'Query',
        item: {
          __typename: 'Node',
          id: 'id',
        },
      },
      stale: false,
      hasNext: false,
    });

    expect(normalData).toMatchObject({ stale: false });
    expect(client.reexecuteOperation).toHaveBeenCalledTimes(0);

    nextOp(extendedOp);

    expect(extendedData).toMatchObject({ stale: true });
    expect(client.reexecuteOperation).toHaveBeenCalledTimes(1);

    // Out of band re-execute first operation
    nextOp(normalOp);
    nextRes({
      ...queryResponse,
      operation: normalOp,
      data: {
        __typename: 'Query',
        item: {
          __typename: 'Node',
          id: 'id',
        },
      },
    });

    expect(normalData).toMatchObject({ stale: false });
    expect(extendedData).toMatchObject({ stale: true });
    expect(client.reexecuteOperation).toHaveBeenCalledTimes(3);

    nextOp(extendedOp);

    expect(normalData).toMatchObject({ stale: false });
    expect(extendedData).toMatchObject({ stale: true });
    expect(client.reexecuteOperation).toHaveBeenCalledTimes(3);

    nextRes({
      ...queryResponse,
      operation: extendedOp,
      data: {
        __typename: 'Query',
        item: {
          __typename: 'Node',
          extended: 'id',
          extra: 'extra',
        },
      },
    });

    expect(extendedData).toMatchObject({ stale: false });
    expect(client.reexecuteOperation).toHaveBeenCalledTimes(4);
  });
});

describe('commutativity', () => {
  it('applies results that come in out-of-order commutatively and consistently', () => {
    vi.useFakeTimers();

    let data: any;

    const client = createClient({
      url: 'http://0.0.0.0',
      requestPolicy: 'cache-and-network',
      exchanges: [],
    });
    const { source: ops$, next: next } = makeSubject<Operation>();
    const query = gql`
      {
        index
      }
    `;

    const result = (operation: Operation): Source<OperationResult> =>
      pipe(
        fromValue({
          ...queryResponse,
          operation,
          data: {
            __typename: 'Query',
            index: operation.key,
          },
        }),
        delay(operation.key === 2 ? 5 : operation.key * 10)
      );

    const output = vi.fn(result => {
      data = result.data;
    });

    const forward = (ops$: Source<Operation>): Source<OperationResult> =>
      pipe(
        ops$,
        filter(op => op.kind !== 'teardown'),
        mergeMap(result)
      );

    pipe(
      cacheExchange()({ forward, client, dispatchDebug })(ops$),
      tap(output),
      publish
    );

    next(
      client.createRequestOperation('query', {
        key: 1,
        query,
        variables: undefined,
      })
    );

    next(
      client.createRequestOperation('query', {
        key: 2,
        query,
        variables: undefined,
      })
    );

    // This shouldn't have any effect:
    next(
      client.createRequestOperation('teardown', {
        key: 2,
        query,
        variables: undefined,
      })
    );

    next(
      client.createRequestOperation('query', {
        key: 3,
        query,
        variables: undefined,
      })
    );

    vi.advanceTimersByTime(5);
    expect(output).toHaveBeenCalledTimes(1);
    expect(data.index).toBe(2);

    vi.advanceTimersByTime(10);
    expect(output).toHaveBeenCalledTimes(2);
    expect(data.index).toBe(2);

    vi.advanceTimersByTime(30);
    expect(output).toHaveBeenCalledTimes(3);
    expect(data.index).toBe(3);
  });

  it('applies optimistic updates on top of commutative queries as query result comes in', () => {
    let data: any;
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next: nextOp } = makeSubject<Operation>();
    const { source: res$, next: nextRes } = makeSubject<OperationResult>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(nextOp);

    const query = gql`
      {
        node {
          id
          name
        }
      }
    `;

    const mutation = gql`
      mutation {
        node {
          id
          name
        }
      }
    `;

    const forward = (ops$: Source<Operation>): Source<OperationResult> =>
      share(
        merge([
          pipe(
            ops$,
            filter(() => false)
          ) as any,
          res$,
        ])
      );

    const optimistic = {
      node: () => ({
        __typename: 'Node',
        id: 'node',
        name: 'optimistic',
      }),
    };

    pipe(
      cacheExchange({ optimistic })({ forward, client, dispatchDebug })(ops$),
      tap(result => {
        if (result.operation.kind === 'query') {
          data = result.data;
        }
      }),
      publish
    );

    const queryOpA = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const mutationOp = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    expect(data).toBe(undefined);

    nextOp(queryOpA);

    nextRes({
      ...queryResponse,
      operation: queryOpA,
      data: {
        __typename: 'Query',
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'query a',
        },
      },
    });

    expect(data).toHaveProperty('node.name', 'query a');

    nextOp(mutationOp);
    expect(reexec).toHaveBeenCalledTimes(1);
    expect(data).toHaveProperty('node.name', 'optimistic');
  });

  it('applies mutation results on top of commutative queries', () => {
    let data: any;
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next: nextOp } = makeSubject<Operation>();
    const { source: res$, next: nextRes } = makeSubject<OperationResult>();

    const reexec = vi
      .spyOn(client, 'reexecuteOperation')
      .mockImplementation(nextOp);

    const query = gql`
      {
        node {
          id
          name
        }
      }
    `;

    const mutation = gql`
      mutation {
        node {
          id
          name
        }
      }
    `;

    const forward = (ops$: Source<Operation>): Source<OperationResult> =>
      share(
        merge([
          pipe(
            ops$,
            filter(() => false)
          ) as any,
          res$,
        ])
      );

    pipe(
      cacheExchange()({ forward, client, dispatchDebug })(ops$),
      tap(result => {
        if (result.operation.kind === 'query') {
          data = result.data;
        }
      }),
      publish
    );

    const queryOpA = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const mutationOp = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    const queryOpB = client.createRequestOperation('query', {
      key: 3,
      query,
      variables: undefined,
    });

    expect(data).toBe(undefined);

    nextOp(queryOpA);
    nextOp(mutationOp);
    nextOp(queryOpB);

    nextRes({
      ...queryResponse,
      operation: queryOpA,
      data: {
        __typename: 'Query',
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'query a',
        },
      },
    });

    expect(data).toHaveProperty('node.name', 'query a');

    nextRes({
      ...queryResponse,
      operation: mutationOp,
      data: {
        __typename: 'Mutation',
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'mutation',
        },
      },
    });

    expect(reexec).toHaveBeenCalledTimes(3);
    expect(data).toHaveProperty('node.name', 'mutation');

    nextRes({
      ...queryResponse,
      operation: queryOpB,
      data: {
        __typename: 'Query',
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'query b',
        },
      },
    });

    expect(reexec).toHaveBeenCalledTimes(4);
    expect(data).toHaveProperty('node.name', 'mutation');
  });

  it('applies optimistic updates on top of commutative queries until mutation resolves', () => {
    let data: any;
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next: nextOp } = makeSubject<Operation>();
    const { source: res$, next: nextRes } = makeSubject<OperationResult>();

    vi.spyOn(client, 'reexecuteOperation').mockImplementation(nextOp);

    const query = gql`
      {
        node {
          id
          name
        }
      }
    `;

    const mutation = gql`
      mutation {
        node {
          id
          name
          optimistic
        }
      }
    `;

    const forward = (ops$: Source<Operation>): Source<OperationResult> =>
      share(
        merge([
          pipe(
            ops$,
            filter(() => false)
          ) as any,
          res$,
        ])
      );

    const optimistic = {
      node: () => ({
        __typename: 'Node',
        id: 'node',
        name: 'optimistic',
      }),
    };

    pipe(
      cacheExchange({ optimistic })({ forward, client, dispatchDebug })(ops$),
      tap(result => {
        if (result.operation.kind === 'query') {
          data = result.data;
        }
      }),
      publish
    );

    const queryOp = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });
    const mutationOp = client.createRequestOperation('mutation', {
      key: 2,
      query: mutation,
      variables: undefined,
    });

    expect(data).toBe(undefined);

    nextOp(queryOp);
    nextOp(mutationOp);

    nextRes({
      ...queryResponse,
      operation: queryOp,
      data: {
        __typename: 'Query',
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'query a',
        },
      },
    });

    expect(data).toHaveProperty('node.name', 'optimistic');

    nextRes({
      ...queryResponse,
      operation: mutationOp,
      data: {
        __typename: 'Query',
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'mutation',
        },
      },
    });

    expect(data).toHaveProperty('node.name', 'mutation');
  });

  it('allows subscription results to be commutative when necessary', () => {
    let data: any;
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next: nextOp } = makeSubject<Operation>();
    const { source: res$, next: nextRes } = makeSubject<OperationResult>();

    vi.spyOn(client, 'reexecuteOperation').mockImplementation(nextOp);

    const query = gql`
      {
        node {
          id
          name
        }
      }
    `;

    const subscription = gql`
      subscription {
        node {
          id
          name
        }
      }
    `;

    const forward = (ops$: Source<Operation>): Source<OperationResult> =>
      share(
        merge([
          pipe(
            ops$,
            filter(() => false)
          ) as any,
          res$,
        ])
      );

    pipe(
      cacheExchange()({ forward, client, dispatchDebug })(ops$),
      tap(result => {
        if (result.operation.kind === 'query') {
          data = result.data;
        }
      }),
      publish
    );

    const queryOpA = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const subscriptionOp = client.createRequestOperation('subscription', {
      key: 3,
      query: subscription,
      variables: undefined,
    });

    nextOp(queryOpA);
    // Force commutative layers to be created:
    nextOp(
      client.createRequestOperation('query', {
        key: 2,
        query,
        variables: undefined,
      })
    );

    nextOp(subscriptionOp);

    nextRes({
      ...queryResponse,
      operation: queryOpA,
      data: {
        __typename: 'Query',
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'query a',
        },
      },
    });

    nextRes({
      ...queryResponse,
      operation: subscriptionOp,
      data: {
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'subscription',
        },
      },
    });

    expect(data).toHaveProperty('node.name', 'subscription');
  });

  it('allows subscription results to be commutative above mutations', () => {
    let data: any;
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next: nextOp } = makeSubject<Operation>();
    const { source: res$, next: nextRes } = makeSubject<OperationResult>();

    vi.spyOn(client, 'reexecuteOperation').mockImplementation(nextOp);

    const query = gql`
      {
        node {
          id
          name
        }
      }
    `;

    const subscription = gql`
      subscription {
        node {
          id
          name
        }
      }
    `;

    const mutation = gql`
      mutation {
        node {
          id
          name
        }
      }
    `;

    const forward = (ops$: Source<Operation>): Source<OperationResult> =>
      share(
        merge([
          pipe(
            ops$,
            filter(() => false)
          ) as any,
          res$,
        ])
      );

    pipe(
      cacheExchange()({ forward, client, dispatchDebug })(ops$),
      tap(result => {
        if (result.operation.kind === 'query') {
          data = result.data;
        }
      }),
      publish
    );

    const queryOpA = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: undefined,
    });

    const subscriptionOp = client.createRequestOperation('subscription', {
      key: 2,
      query: subscription,
      variables: undefined,
    });

    const mutationOp = client.createRequestOperation('mutation', {
      key: 3,
      query: mutation,
      variables: undefined,
    });

    nextOp(queryOpA);
    // Force commutative layers to be created:
    nextOp(
      client.createRequestOperation('query', {
        key: 2,
        query,
        variables: undefined,
      })
    );

    nextOp(subscriptionOp);

    nextRes({
      ...queryResponse,
      operation: queryOpA,
      data: {
        __typename: 'Query',
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'query a',
        },
      },
    });

    nextOp(mutationOp);

    nextRes({
      ...queryResponse,
      operation: mutationOp,
      data: {
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'mutation',
        },
      },
    });

    nextRes({
      ...queryResponse,
      operation: subscriptionOp,
      data: {
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'subscription a',
        },
      },
    });

    nextRes({
      ...queryResponse,
      operation: subscriptionOp,
      data: {
        node: {
          __typename: 'Node',
          id: 'node',
          name: 'subscription b',
        },
      },
    });

    expect(data).toHaveProperty('node.name', 'subscription b');
  });

  it('applies deferred results to previous layers', () => {
    let normalData: OperationResult | undefined;
    let deferredData: OperationResult | undefined;
    let combinedData: OperationResult | undefined;

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next: nextOp } = makeSubject<Operation>();
    const { source: res$, next: nextRes } = makeSubject<OperationResult>();
    client.reexecuteOperation = nextOp;

    const normalQuery = gql`
      {
        node {
          id
          name
        }
      }
    `;

    const deferredQuery = gql`
      {
        ... @defer {
          deferred {
            id
            name
          }
        }
      }
    `;

    const combinedQuery = gql`
      {
        node {
          id
          name
        }
        ... @defer {
          deferred {
            id
            name
          }
        }
      }
    `;

    const forward = (operations$: Source<Operation>): Source<OperationResult> =>
      share(
        merge([
          pipe(
            operations$,
            filter(() => false)
          ) as any,
          res$,
        ])
      );

    pipe(
      cacheExchange()({ forward, client, dispatchDebug })(ops$),
      tap(result => {
        if (result.operation.kind === 'query') {
          if (result.operation.key === 1) {
            deferredData = result;
          } else if (result.operation.key === 42) {
            combinedData = result;
          } else {
            normalData = result;
          }
        }
      }),
      publish
    );

    const combinedOp = client.createRequestOperation('query', {
      key: 42,
      query: combinedQuery,
      variables: undefined,
    });
    const deferredOp = client.createRequestOperation('query', {
      key: 1,
      query: deferredQuery,
      variables: undefined,
    });
    const normalOp = client.createRequestOperation('query', {
      key: 2,
      query: normalQuery,
      variables: undefined,
    });

    nextOp(combinedOp);
    nextOp(deferredOp);
    nextOp(normalOp);

    nextRes({
      ...queryResponse,
      operation: deferredOp,
      data: {
        __typename: 'Query',
      },
      hasNext: true,
    });

    expect(deferredData).not.toHaveProperty('deferred');

    nextRes({
      ...queryResponse,
      operation: normalOp,
      data: {
        __typename: 'Query',
        node: {
          __typename: 'Node',
          id: 2,
          name: 'normal',
        },
      },
    });

    expect(normalData).toHaveProperty('data.node.id', 2);
    expect(combinedData).not.toHaveProperty('data.deferred');
    expect(combinedData).toHaveProperty('data.node.id', 2);

    nextRes({
      ...queryResponse,
      operation: deferredOp,
      data: {
        __typename: 'Query',
        deferred: {
          __typename: 'Node',
          id: 1,
          name: 'deferred',
        },
      },
      hasNext: true,
    });

    expect(deferredData).toHaveProperty('hasNext', true);
    expect(deferredData).toHaveProperty('data.deferred.id', 1);

    expect(combinedData).toHaveProperty('hasNext', false);
    expect(combinedData).toHaveProperty('data.deferred.id', 1);
    expect(combinedData).toHaveProperty('data.node.id', 2);
  });

  it('applies deferred logic only to deferred operations', () => {
    let failingData: OperationResult | undefined;

    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });

    const { source: ops$, next: nextOp } = makeSubject<Operation>();
    const { source: res$ } = makeSubject<OperationResult>();

    const deferredQuery = gql`
      {
        ... @defer {
          deferred {
            id
            name
          }
        }
      }
    `;

    const failingQuery = gql`
      {
        deferred {
          id
          name
        }
      }
    `;

    const forward = (ops$: Source<Operation>): Source<OperationResult> =>
      share(
        merge([
          pipe(
            ops$,
            filter(() => false)
          ) as any,
          res$,
        ])
      );

    pipe(
      cacheExchange()({ forward, client, dispatchDebug })(ops$),
      tap(result => {
        if (result.operation.kind === 'query') {
          if (result.operation.key === 1) {
            failingData = result;
          }
        }
      }),
      publish
    );

    const failingOp = client.createRequestOperation('query', {
      key: 1,
      query: failingQuery,
      variables: undefined,
    });
    const deferredOp = client.createRequestOperation('query', {
      key: 2,
      query: deferredQuery,
      variables: undefined,
    });

    nextOp(deferredOp);
    nextOp(failingOp);

    expect(failingData).not.toMatchObject({ hasNext: true });
  });
});

describe('abstract types', () => {
  it('works with two responses giving different concrete types for a union', () => {
    const query = gql`
      query ($id: ID!) {
        field(id: $id) {
          id
          union {
            ... on Type1 {
              id
              name
              __typename
            }
            ... on Type2 {
              id
              title
              __typename
            }
          }
          __typename
        }
      }
    `;
    const client = createClient({
      url: 'http://0.0.0.0',
      exchanges: [],
    });
    const { source: ops$, next } = makeSubject<Operation>();
    const operation1 = client.createRequestOperation('query', {
      key: 1,
      query,
      variables: { id: '1' },
    });
    const operation2 = client.createRequestOperation('query', {
      key: 2,
      query,
      variables: { id: '2' },
    });
    const queryResult1: OperationResult = {
      ...queryResponse,
      operation: operation1,
      data: {
        __typename: 'Query',
        field: {
          id: '1',
          __typename: 'Todo',
          union: {
            id: '1',
            name: 'test',
            __typename: 'Type1',
          },
        },
      },
    };

    const queryResult2: OperationResult = {
      ...queryResponse,
      operation: operation2,
      data: {
        __typename: 'Query',
        field: {
          id: '2',
          __typename: 'Todo',
          union: {
            id: '2',
            title: 'test',
            __typename: 'Type2',
          },
        },
      },
    };

    vi.spyOn(client, 'reexecuteOperation').mockImplementation(next);
    const response = vi.fn((forwardOp: Operation): OperationResult => {
      if (forwardOp.key === 1) return queryResult1;
      if (forwardOp.key === 2) return queryResult2;
      return undefined as any;
    });

    const result = vi.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response), share);

    pipe(
      cacheExchange({})({ forward, client, dispatchDebug })(ops$),
      tap(result),
      publish
    );

    next(operation1);
    expect(response).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    expect(result.mock.calls[0][0].data).toEqual({
      field: {
        __typename: 'Todo',
        id: '1',
        union: {
          __typename: 'Type1',
          id: '1',
          name: 'test',
        },
      },
    });

    next(operation2);
    expect(response).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(2);
    expect(result.mock.calls[1][0].data).toEqual({
      field: {
        __typename: 'Todo',
        id: '2',
        union: {
          __typename: 'Type2',
          id: '2',
          title: 'test',
        },
      },
    });
  });
});
