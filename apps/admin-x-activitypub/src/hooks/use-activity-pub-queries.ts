import {
    type Account,
    type AccountFollowsType,
    type AccountSearchResult,
    ActivityPubAPI,
    ActivityPubCollectionResponse,
    FollowAccount,
    type GetAccountFollowsResponse,
    type Notification,
    type Post,
    type ReplyChainResponse,
    type SearchResults
} from '../api/activitypub';
import {Activity, ActorProperties} from '@tryghost/admin-x-framework/api/activitypub';
import {
    type QueryClient,
    type UseInfiniteQueryResult,
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient
} from '@tanstack/react-query';
import {exploreSites} from '@src/lib/explore-sites';
import {formatPendingActivityContent, generatePendingActivity, generatePendingActivityId} from '../utils/pending-activity';
import {mapPostToActivity} from '../utils/posts';
import {toast} from 'sonner';
import {useCallback, useEffect, useState} from 'react';

export type ActivityPubCollectionQueryResult<TData> = UseInfiniteQueryResult<ActivityPubCollectionResponse<TData>>;
export type AccountFollowsQueryResult = UseInfiniteQueryResult<GetAccountFollowsResponse>;

let SITE_URL: string;

async function getSiteUrl() {
    if (!SITE_URL) {
        const response = await fetch('/ghost/api/admin/site');
        const json = await response.json();
        SITE_URL = json.site.url;
    }

    return SITE_URL;
}

function createActivityPubAPI(handle: string, siteUrl: string) {
    return new ActivityPubAPI(
        new URL(siteUrl),
        new URL('/ghost/api/admin/identities/', window.location.origin),
        handle
    );
}

const QUERY_KEYS = {
    outbox: (handle: string) => ['outbox', handle],
    liked: (handle: string) => ['liked', handle],
    user: (handle: string) => ['user', handle],
    profilePosts: (profileHandle: string | null) => {
        if (profileHandle === null) {
            return ['profile_posts'];
        }
        return ['profile_posts', profileHandle];
    },
    account: (handle: string) => ['account', handle],
    accountFollows: (handle: string, type: AccountFollowsType) => ['account_follows', handle, type],
    searchResults: (query: string) => ['search_results', query],
    suggestedProfiles: (handle: string, limit: number) => ['suggested_profiles', handle, limit],
    exploreProfiles: (handle: string) => ['explore_profiles', handle],
    thread: (id: string | null) => {
        if (id === null) {
            return ['thread'];
        }
        return ['thread', id];
    },
    replyChain: (id: string | null) => {
        if (id === null) {
            return ['reply_chain'];
        }
        return ['reply_chain', id];
    },
    feed: ['feed'],
    inbox: ['inbox'],
    postsByAccount: ['account_posts'],
    postsLikedByAccount: ['account_liked_posts'],
    notifications: (handle: string) => ['notifications', handle],
    notificationsCount: (handle: string) => ['notifications_count', handle],
    blockedAccounts: (handle: string) => ['blocked_accounts', handle],
    blockedDomains: (handle: string) => ['blocked_domains', handle],
    post: (id: string) => ['post', id]
};

function updateLikedCache(queryClient: QueryClient, queryKey: string[], id: string, liked: boolean) {
    queryClient.setQueriesData(queryKey, (current?: {pages: {posts: Activity[]}[]}) => {
        if (current === undefined) {
            return current;
        }

        return {
            ...current,
            pages: current.pages.map((page: {posts: Activity[]}) => {
                return {
                    ...page,
                    posts: page.posts.map((item: Activity) => {
                        if (item.object.id === id) {
                            return {
                                ...item,
                                object: {
                                    ...item.object,
                                    liked: liked,
                                    likeCount: Math.max(liked ? (item.object.likeCount || 0) + 1 : (item.object.likeCount || 0) - 1, 0)
                                }
                            };
                        }

                        return item;
                    })
                };
            })
        };
    });

    // For the likes tab, add/remove the post
    if (queryKey === QUERY_KEYS.postsLikedByAccount) {
        queryClient.setQueriesData(queryKey, (current?: {pages: {posts: Activity[]}[]}) => {
            if (!current) {
                return current;
            }

            return {
                ...current,
                pages: current.pages.map((page: {posts: Activity[]}) => {
                    return {
                        ...page,
                        posts: liked
                            // If liking, keep the post (it will be added via refetch)
                            ? page.posts
                            // If unliking, remove the post
                            : page.posts.filter(item => item.object.id !== id)
                    };
                })
            };
        });

        // Invalidate the likes tab query to refetch and get the new post when liking
        if (liked) {
            queryClient.invalidateQueries({queryKey: QUERY_KEYS.postsLikedByAccount});
        }
    }
}

function updateNotificationsLikedCache(queryClient: QueryClient, handle: string, id: string, liked: boolean) {
    const notificationQueryKey = QUERY_KEYS.notifications(handle);
    queryClient.setQueriesData(
        {queryKey: notificationQueryKey},
        (current?: {pages?: {notifications?: Notification[]}[]}) => {
            if (!current || !current.pages) {
                return current;
            }

            try {
                return {
                    ...current,
                    pages: current.pages.map((page) => {
                        if (!page || !page.notifications) {
                            return page;
                        }

                        return {
                            ...page,
                            notifications: page.notifications.map((notification) => {
                                if (!notification || !notification.post) {
                                    return notification;
                                }

                                if (notification.post.id === id) {
                                    return {
                                        ...notification,
                                        post: {
                                            ...notification.post,
                                            likedByMe: liked,
                                            likeCount: Math.max(liked ? notification.post.likeCount + 1 : notification.post.likeCount - 1, 0)
                                        }
                                    };
                                }
                                return notification;
                            })
                        };
                    })
                };
            } catch (error) {
                return current;
            }
        }
    );
}

function updateNotificationsRepostCache(queryClient: QueryClient, handle: string, id: string, reposted: boolean) {
    const notificationQueryKey = QUERY_KEYS.notifications(handle);
    queryClient.setQueriesData(
        {queryKey: notificationQueryKey},
        (current?: {pages?: {notifications?: Notification[]}[]}) => {
            if (!current || !current.pages) {
                return current;
            }

            try {
                return {
                    ...current,
                    pages: current.pages.map((page) => {
                        if (!page || !page.notifications) {
                            return page;
                        }

                        return {
                            ...page,
                            notifications: page.notifications.map((notification) => {
                                if (!notification || !notification.post) {
                                    return notification;
                                }

                                if (notification.post.id === id) {
                                    return {
                                        ...notification,
                                        post: {
                                            ...notification.post,
                                            repostedByMe: reposted,
                                            repostCount: Math.max(reposted ? notification.post.repostCount + 1 : notification.post.repostCount - 1, 0)
                                        }
                                    };
                                }
                                return notification;
                            })
                        };
                    })
                };
            } catch (error) {
                return current;
            }
        }
    );
}

function updateNotificationsReplyCountCache(queryClient: QueryClient, handle: string, id: string, delta: number) {
    const notificationQueryKey = QUERY_KEYS.notifications(handle);
    queryClient.setQueriesData(
        {queryKey: notificationQueryKey},
        (current?: {pages?: {notifications?: Notification[]}[]}) => {
            if (!current || !current.pages) {
                return current;
            }

            try {
                return {
                    ...current,
                    pages: current.pages.map((page) => {
                        if (!page || !page.notifications) {
                            return page;
                        }

                        return {
                            ...page,
                            notifications: page.notifications.map((notification) => {
                                if (!notification || !notification.post) {
                                    return notification;
                                }

                                if (notification.post.id === id) {
                                    return {
                                        ...notification,
                                        post: {
                                            ...notification.post,
                                            replyCount: Math.max((notification.post.replyCount ?? 0) + delta, 0)
                                        }
                                    };
                                }
                                return notification;
                            })
                        };
                    })
                };
            } catch (error) {
                return current;
            }
        }
    );
}

function updateReplyCountInCache(queryClient: QueryClient, id: string, delta: number) {
    const queryKeys = [
        QUERY_KEYS.feed,
        QUERY_KEYS.inbox,
        QUERY_KEYS.profilePosts('index'),
        QUERY_KEYS.postsLikedByAccount
    ];

    for (const queryKey of queryKeys) {
        queryClient.setQueriesData(queryKey, (current?: {pages: {posts: Activity[]}[]}) => {
            if (!current) {
                return current;
            }

            return {
                ...current,
                pages: current.pages.map(page => ({
                    ...page,
                    posts: page.posts.map((activity) => {
                        if (activity.object.id === id) {
                            return {
                                ...activity,
                                object: {
                                    ...activity.object,
                                    replyCount: Math.max((activity.object.replyCount ?? 0) + delta, 0)
                                }
                            };
                        }
                        return activity;
                    })
                }))
            };
        });
    }

    // Update thread cache
    const threadQueryKey = QUERY_KEYS.thread(null);
    queryClient.setQueriesData(threadQueryKey, (current?: {posts: Activity[]}) => {
        if (!current) {
            return current;
        }

        return {
            posts: current.posts.map((activity) => {
                if (activity.object.id === id) {
                    return {
                        ...activity,
                        object: {
                            ...activity.object,
                            replyCount: Math.max((activity.object.replyCount ?? 0) + delta, 0)
                        }
                    };
                }
                return activity;
            })
        };
    });
}

export function useBlockedAccountsForUser(handle: string) {
    return useInfiniteQuery({
        queryKey: QUERY_KEYS.blockedAccounts(handle),
        refetchOnMount: 'always',
        async queryFn({pageParam}: {pageParam?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.getBlockedAccounts(pageParam);
        },
        getNextPageParam(prevPage) {
            return prevPage.next;
        }
    });
}

export function useBlockedDomainsForUser(handle: string) {
    return useInfiniteQuery({
        queryKey: QUERY_KEYS.blockedDomains(handle),
        refetchOnMount: 'always',
        async queryFn({pageParam}: {pageParam?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.getBlockedDomains(pageParam);
        },
        getNextPageParam(prevPage) {
            return prevPage.next;
        }
    });
}

export function useLikeMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(id: string) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.like(id);
        },
        onMutate: (id) => {
            updateLikedCache(queryClient, QUERY_KEYS.feed, id, true);
            updateLikedCache(queryClient, QUERY_KEYS.inbox, id, true);
            updateLikedCache(queryClient, QUERY_KEYS.postsLikedByAccount, id, true);
            updateNotificationsLikedCache(queryClient, handle, id, true);

            // Update all profile post caches (not just current user's)
            const profilePostsQueryKey = QUERY_KEYS.profilePosts(null);
            queryClient.setQueriesData(profilePostsQueryKey, (current?: {pages: {posts: Activity[]}[]}) => {
                if (current === undefined) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {posts: Activity[]}) => {
                        return {
                            ...page,
                            posts: page.posts.map((item: Activity) => {
                                if (item.object.id === id) {
                                    return {
                                        ...item,
                                        object: {
                                            ...item.object,
                                            liked: true,
                                            likeCount: Math.max((item.object.likeCount || 0) + 1, 0)
                                        }
                                    };
                                }

                                return item;
                            })
                        };
                    })
                };
            });

            // Update the individual post cache (used by Reader)
            const postQueryKey = QUERY_KEYS.post(id);
            queryClient.setQueryData(postQueryKey, (current?: Activity) => {
                if (!current || current.object.id !== id) {
                    return current;
                }

                return {
                    ...current,
                    object: {
                        ...current.object,
                        liked: true,
                        likeCount: Math.max((current.object.likeCount || 0) + 1, 0)
                    }
                };
            });

            // Update the thread cache (used by Note.tsx)
            const threadQueryKey = QUERY_KEYS.thread(null);
            queryClient.setQueriesData(threadQueryKey, (current?: {posts: Activity[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    posts: current.posts.map((activity) => {
                        if (activity.object.id === id) {
                            return {
                                ...activity,
                                object: {
                                    ...activity.object,
                                    liked: true,
                                    likeCount: Math.max((activity.object.likeCount || 0) + 1, 0)
                                }
                            };
                        }
                        return activity;
                    })
                };
            });

            // Update account liked count
            queryClient.setQueryData(QUERY_KEYS.account('index'), (currentAccount?: Account) => {
                if (!currentAccount) {
                    return currentAccount;
                }
                return {
                    ...currentAccount,
                    likedCount: currentAccount.likedCount + 1
                };
            });
        },
        onError(error: {message: string, statusCode: number}, id) {
            updateLikedCache(queryClient, QUERY_KEYS.feed, id, false);
            updateLikedCache(queryClient, QUERY_KEYS.inbox, id, false);
            updateLikedCache(queryClient, QUERY_KEYS.postsLikedByAccount, id, false);
            updateNotificationsLikedCache(queryClient, handle, id, false);

            // Revert all profile post caches (not just current user's)
            const profilePostsQueryKey = QUERY_KEYS.profilePosts(null);
            queryClient.setQueriesData(profilePostsQueryKey, (current?: {pages: {posts: Activity[]}[]}) => {
                if (current === undefined) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {posts: Activity[]}) => {
                        return {
                            ...page,
                            posts: page.posts.map((item: Activity) => {
                                if (item.object.id === id) {
                                    return {
                                        ...item,
                                        object: {
                                            ...item.object,
                                            liked: false,
                                            likeCount: Math.max((item.object.likeCount || 0) - 1, 0)
                                        }
                                    };
                                }

                                return item;
                            })
                        };
                    })
                };
            });

            // Revert the individual post cache (used by Reader)
            const postQueryKey = QUERY_KEYS.post(id);
            queryClient.setQueryData(postQueryKey, (current?: Activity) => {
                if (!current || current.object.id !== id) {
                    return current;
                }

                return {
                    ...current,
                    object: {
                        ...current.object,
                        liked: false,
                        likeCount: Math.max((current.object.likeCount || 0) - 1, 0)
                    }
                };
            });

            // Revert the thread cache (used by Note.tsx)
            const threadQueryKey = QUERY_KEYS.thread(null);
            queryClient.setQueriesData(threadQueryKey, (current?: {posts: Activity[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    posts: current.posts.map((activity) => {
                        if (activity.object.id === id) {
                            return {
                                ...activity,
                                object: {
                                    ...activity.object,
                                    liked: false,
                                    likeCount: Math.max((activity.object.likeCount || 0) - 1, 0)
                                }
                            };
                        }
                        return activity;
                    })
                };
            });

            // Update account liked count
            queryClient.setQueryData(QUERY_KEYS.account('index'), (currentAccount?: Account) => {
                if (!currentAccount) {
                    return currentAccount;
                }
                return {
                    ...currentAccount,
                    likedCount: currentAccount.likedCount - 1
                };
            });

            if (error.statusCode === 403) {
                toast.error('Action failed', {
                    description: 'This user has restricted who can interact with their account.'
                });
            }
        }
    });
}

export function useUnlikeMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(id: string) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.unlike(id);
        },
        onMutate: (id) => {
            updateLikedCache(queryClient, QUERY_KEYS.feed, id, false);
            updateLikedCache(queryClient, QUERY_KEYS.inbox, id, false);
            updateLikedCache(queryClient, QUERY_KEYS.postsLikedByAccount, id, false);
            updateNotificationsLikedCache(queryClient, handle, id, false);

            // Update all profile post caches (not just current user's)
            const profilePostsQueryKey = QUERY_KEYS.profilePosts(null);
            queryClient.setQueriesData(profilePostsQueryKey, (current?: {pages: {posts: Activity[]}[]}) => {
                if (current === undefined) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {posts: Activity[]}) => {
                        return {
                            ...page,
                            posts: page.posts.map((item: Activity) => {
                                if (item.object.id === id) {
                                    return {
                                        ...item,
                                        object: {
                                            ...item.object,
                                            liked: false,
                                            likeCount: Math.max((item.object.likeCount || 0) - 1, 0)
                                        }
                                    };
                                }

                                return item;
                            })
                        };
                    })
                };
            });

            // Update the individual post cache (used by Reader)
            const postQueryKey = QUERY_KEYS.post(id);
            queryClient.setQueryData(postQueryKey, (current?: Activity) => {
                if (!current || current.object.id !== id) {
                    return current;
                }

                return {
                    ...current,
                    object: {
                        ...current.object,
                        liked: false,
                        likeCount: Math.max((current.object.likeCount || 0) - 1, 0)
                    }
                };
            });

            // Update the thread cache (used by Note.tsx)
            const threadQueryKey = QUERY_KEYS.thread(null);
            queryClient.setQueriesData(threadQueryKey, (current?: {posts: Activity[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    posts: current.posts.map((activity) => {
                        if (activity.object.id === id) {
                            return {
                                ...activity,
                                object: {
                                    ...activity.object,
                                    liked: false,
                                    likeCount: Math.max((activity.object.likeCount || 0) - 1, 0)
                                }
                            };
                        }
                        return activity;
                    })
                };
            });

            // Update account liked count
            queryClient.setQueryData(QUERY_KEYS.account(handle === 'me' ? 'index' : handle), (currentAccount?: Account) => {
                if (!currentAccount) {
                    return currentAccount;
                }
                return {
                    ...currentAccount,
                    likedCount: Math.max(0, currentAccount.likedCount - 1)
                };
            });
        }
    });
}

export function useBlockDomainMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(data: {url: string, handle?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.blockDomain(new URL(data.url));
        },
        onMutate: (data: {url: string, handle?: string}) => {
            if (!data.handle) {
                return;
            }
            queryClient.setQueryData(
                QUERY_KEYS.account(handle),
                (currentAccount?: Account) => {
                    if (!currentAccount) {
                        return currentAccount;
                    }
                    return {
                        ...currentAccount,
                        domainBlockedByMe: true,
                        followedByMe: false,
                        followsMe: false
                    };
                }
            );
        }
    });
}

export function useUnblockDomainMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(data: {url: string, handle?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.unblockDomain(new URL(data.url));
        },
        onMutate: (data: {url: string, handle?: string}) => {
            if (!data.handle) {
                return;
            }
            queryClient.setQueryData(
                QUERY_KEYS.account(handle),
                (currentAccount?: Account) => {
                    if (!currentAccount) {
                        return currentAccount;
                    }
                    return {
                        ...currentAccount,
                        domainBlockedByMe: false
                    };
                }
            );
        }
    });
}

export function useBlockMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(account: Account) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.block(new URL(account.apId));
        },
        onMutate: (account: Account) => {
            queryClient.setQueryData(
                QUERY_KEYS.account(account.handle),
                (currentAccount?: Account) => {
                    if (!currentAccount) {
                        return currentAccount;
                    }
                    return {
                        ...currentAccount,
                        blockedByMe: true,
                        followedByMe: false,
                        followsMe: false
                    };
                }
            );
            queryClient.invalidateQueries({queryKey: QUERY_KEYS.feed});
            queryClient.invalidateQueries({queryKey: QUERY_KEYS.inbox});
        }
    });
}

export function useUnblockMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(account: Account) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.unblock(new URL(account.apId));
        },
        onMutate: (account: Account) => {
            queryClient.setQueryData(
                QUERY_KEYS.account(account.handle),
                (currentAccount?: Account) => {
                    if (!currentAccount) {
                        return currentAccount;
                    }
                    return {
                        ...currentAccount,
                        blockedByMe: false
                    };
                }
            );
        }
    });
}

function updateRepostCache(queryClient: QueryClient, queryKey: string[], id: string, reposted: boolean) {
    queryClient.setQueriesData(queryKey, (current?: {pages: {posts: Activity[]}[]}) => {
        if (current === undefined) {
            return current;
        }

        return {
            ...current,
            pages: current.pages.map((page: {posts: Activity[]}) => {
                return {
                    ...page,
                    posts: page.posts.map((item: Activity) => {
                        if (item.object.id === id) {
                            return {
                                ...item,
                                object: {
                                    ...item.object,
                                    reposted: reposted,
                                    repostCount: Math.max(reposted ? item.object.repostCount + 1 : item.object.repostCount - 1, 0)
                                }
                            };
                        }

                        return item;
                    })
                };
            })
        };
    });
}

export function useRepostMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(id: string) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.repost(id);
        },
        onMutate: (id) => {
            updateRepostCache(queryClient, QUERY_KEYS.feed, id, true);
            updateRepostCache(queryClient, QUERY_KEYS.inbox, id, true);
            updateNotificationsRepostCache(queryClient, handle, id, true);
        },
        onError(error: {message: string, statusCode: number}, id) {
            updateRepostCache(queryClient, QUERY_KEYS.feed, id, false);
            updateRepostCache(queryClient, QUERY_KEYS.inbox, id, false);
            updateNotificationsRepostCache(queryClient, handle, id, false);
            if (error.statusCode === 403) {
                toast.error('Action failed', {
                    description: 'This user has restricted who can interact with their account.'
                });
            }
        }
    });
}

export function useDerepostMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(id: string) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.derepost(id);
        },
        onMutate: (id) => {
            updateRepostCache(queryClient, QUERY_KEYS.feed, id, false);
            updateRepostCache(queryClient, QUERY_KEYS.inbox, id, false);
            updateNotificationsRepostCache(queryClient, handle, id, false);
        }
    });
}

export function useUserDataForUser(handle: string) {
    return useQuery({
        queryKey: QUERY_KEYS.user(handle),
        async queryFn() {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.getUser();
        }
    });
}

export function useUnfollowMutationForUser(handle: string, onSuccess: () => void, onError: () => void) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(username: string) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.unfollow(username);
        },
        onSuccess(_, fullHandle) {
            // Update the "isFollowing" and "followerCount" properties of the profile being unfollowed
            const profileQueryKey = QUERY_KEYS.account(fullHandle === 'me' ? 'index' : fullHandle);

            queryClient.setQueryData(profileQueryKey, (currentProfile?: {followedByMe: boolean, followerCount: number}) => {
                if (!currentProfile) {
                    return currentProfile;
                }

                return {
                    ...currentProfile,
                    followedByMe: false,
                    followerCount: currentProfile.followerCount - 1 < 0 ? 0 : currentProfile.followerCount - 1
                };
            });

            // Update the profile followers query cache for the profile being unfollowed
            const profileFollowersQueryKey = QUERY_KEYS.accountFollows(fullHandle, 'followers');

            queryClient.setQueryData(profileFollowersQueryKey, (oldData?: {
                pages: Array<{
                    accounts: Array<{
                        id: string;
                        type: string;
                        preferredUsername: string;
                        name: string;
                        url: string;
                        icon: {
                            type: string;
                            url: string;
                            },
                        isFollowing: boolean;
                    }>;
                }>;
            }) => {
                if (!oldData?.pages?.[0]) {
                    return oldData;
                }

                const currentAccount = queryClient.getQueryData<Account>(QUERY_KEYS.account('index'));
                if (!currentAccount) {
                    return oldData;
                }

                return {
                    ...oldData,
                    pages: oldData.pages.map((page: {
                        accounts: Array<{
                                id: string;
                                type: string;
                                preferredUsername: string;
                                name: string;
                                url: string;
                                icon: {
                                    type: string;
                                    url: string;
                                },
                            isFollowing: boolean;
                        }>;
                    }) => ({
                        ...page,
                        accounts: page.accounts.filter((follower: {
                            id: string;
                            type: string;
                            preferredUsername: string;
                            name: string;
                            url: string;
                            icon: {
                                type: string;
                                url: string;
                                },
                            isFollowing: boolean;
                        }) => follower.name !== currentAccount.name)
                    }))
                };
            });

            // Update the "followingCount" property of the account performing the follow
            const accountQueryKey = QUERY_KEYS.account('index');

            queryClient.setQueryData(accountQueryKey, (currentAccount?: { followingCount: number }) => {
                if (!currentAccount) {
                    return currentAccount;
                }

                return {
                    ...currentAccount,
                    followingCount: currentAccount.followingCount - 1
                };
            });

            // Remove the unfollowed actor from the follows query cache for the account performing the unfollow
            const accountFollowsQueryKey = QUERY_KEYS.accountFollows(handle, 'following');

            queryClient.setQueryData(accountFollowsQueryKey, (currentFollows?: {pages: {accounts: FollowAccount[]}[]}) => {
                if (!currentFollows) {
                    return currentFollows;
                }

                return {
                    ...currentFollows,
                    pages: currentFollows.pages.map(page => ({
                        ...page,
                        data: page.accounts.filter(account => account.handle !== fullHandle)
                    }))
                };
            });

            onSuccess();
        },
        onError
    });
}

export function useFollowMutationForUser(handle: string, onSuccess: () => void, onError: () => void) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(username: string) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.follow(username);
        },
        onSuccess(_, fullHandle) {
            // Update the "isFollowing" and "followerCount" properties of the profile being followed
            const profileQueryKey = QUERY_KEYS.account(fullHandle === 'me' ? 'index' : fullHandle);

            queryClient.setQueryData(profileQueryKey, (currentProfile?: {followedByMe: boolean, followerCount: number}) => {
                if (!currentProfile) {
                    return currentProfile;
                }

                return {
                    ...currentProfile,
                    followedByMe: true,
                    followerCount: currentProfile.followerCount + 1
                };
            });

            // Update the "followingCount" property of the account performing the follow
            const accountQueryKey = QUERY_KEYS.account('index');

            queryClient.setQueryData(accountQueryKey, (currentAccount?: { followingCount: number }) => {
                if (!currentAccount) {
                    return currentAccount;
                }

                return {
                    ...currentAccount,
                    followingCount: currentAccount.followingCount + 1
                };
            });

            const profileFollowersQueryKey = QUERY_KEYS.accountFollows(fullHandle, 'followers');

            // Invalidate the follows query cache for the account performing the follow
            // because we cannot directly add to it due to potentially incompatible data
            // shapes
            const accountFollowsQueryKey = QUERY_KEYS.accountFollows(handle, 'following');

            queryClient.invalidateQueries({queryKey: accountFollowsQueryKey});

            // Add new follower to the followers list cache
            queryClient.setQueryData(profileFollowersQueryKey, (oldData?: {
                pages: Array<{
                    accounts: Array<{
                        id: string;
                        type: string;
                        preferredUsername: string;
                        name: string;
                        url: string;
                        icon: {
                            type: string;
                            url: string;
                            },
                        isFollowing: boolean;
                    }>;
                }>;
            }) => {
                if (!oldData?.pages?.[0]) {
                    return oldData;
                }

                const currentAccount = queryClient.getQueryData<Account>(QUERY_KEYS.account('index'));
                if (!currentAccount) {
                    return oldData;
                }

                const newFollower = {
                    id: currentAccount.url,
                    type: 'Person',
                    preferredUsername: 'index',
                    name: currentAccount.name,
                    url: currentAccount.url,
                    handle: `index@${new URL(currentAccount.url).hostname}`,
                    icon: {
                        type: 'Image',
                        url: currentAccount.avatarUrl
                    },
                    isFollowing: false
                };

                return {
                    ...oldData,
                    pages: [{
                        ...oldData.pages[0],
                        accounts: [newFollower, ...oldData.pages[0].accounts]
                    }, ...oldData.pages.slice(1)]
                };
            });

            onSuccess();
        },
        onError(error: {message: string, statusCode: number}) {
            onError();

            if (error.statusCode === 403) {
                toast.error('Action failed', {
                    description: 'This user has restricted who can interact with their account.'
                });
            }
        }
    });
}

export function useSearchForUser(handle: string, query: string) {
    const queryClient = useQueryClient();
    const queryKey = QUERY_KEYS.searchResults(query);

    const searchQuery = useQuery({
        queryKey,
        enabled: query.length > 0,
        refetchOnMount: 'always',
        async queryFn() {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.search(query);
        }
    });

    const updateAccountSearchResult = (id: string, updated: Partial<AccountSearchResult>) => {
        // Update the account search result stored in the search results query cache
        queryClient.setQueryData(queryKey, (current: SearchResults | undefined) => {
            if (!current) {
                return current;
            }

            return {
                ...current,
                accounts: current.accounts.map((item: AccountSearchResult) => {
                    if (item.id === id) {
                        return {...item, ...updated};
                    }

                    return item;
                })
            };
        });
    };

    return {searchQuery, updateAccountSearchResult};
}

export function useExploreProfilesForUser(handle: string) {
    const queryClient = useQueryClient();
    const queryKey = QUERY_KEYS.exploreProfiles(handle);

    const fetchExploreProfiles = useCallback(async ({pageParam = 0}: {pageParam?: number}) => {
        const siteUrl = await getSiteUrl();
        const api = createActivityPubAPI(handle, siteUrl);

        // Collect all handles with their category info
        const allHandles = Object.entries(exploreSites).flatMap(([key, category]) => category.sites.map(profileHandle => ({
            key,
            categoryName: category.categoryName,
            profileHandle
        })));

        // Calculate pagination
        const pageSize = 10; // Number of profiles per page
        const startIndex = pageParam * pageSize;
        const endIndex = startIndex + pageSize;

        // Ensure we don't go beyond the total number of handles
        if (startIndex >= allHandles.length) {
            return {
                results: {},
                nextPage: undefined
            };
        }

        const paginatedHandles = allHandles.slice(startIndex, endIndex);

        // Fetch profiles for current page
        const allResults = await Promise.allSettled(
            paginatedHandles.map(item => api.getAccount(item.profileHandle)
                .then(profile => ({...item, profile}))
            )
        );

        // Organize results back into categories
        const results: Record<string, { categoryName: string; sites: Account[] }> = {};

        allResults
            .filter((result): result is PromiseFulfilledResult<typeof allHandles[0] & { profile: Account }> => result.status === 'fulfilled'
            )
            .forEach((result) => {
                const {key, categoryName, profile} = result.value;

                if (!results[key]) {
                    results[key] = {categoryName, sites: []};
                }

                results[key].sites.push(profile);
            });

        return {
            results,
            nextPage: endIndex < allHandles.length ? pageParam + 1 : undefined
        };
    }, [handle]);

    const exploreProfilesQuery = useInfiniteQuery({
        queryKey,
        queryFn: ({pageParam = 0}) => fetchExploreProfiles({pageParam}),
        getNextPageParam: lastPage => lastPage.nextPage
    });

    const updateExploreProfile = (id: string, updated: Partial<Account>) => {
        queryClient.setQueryData(queryKey, (current: {pages: Array<{results: Record<string, { categoryName: string; sites: Account[] }>}>} | undefined) => {
            if (!current) {
                return current;
            }

            // Create a new pages array with updated profiles
            const updatedPages = current.pages.map((page) => {
                // Create a new results object with updated categories
                const updatedResults = Object.entries(page.results).reduce((acc, [categoryKey, category]) => {
                    // Update the sites array for this category
                    const updatedSites = category.sites.map((profile) => {
                        if (profile.id === id) {
                            return {...profile, ...updated};
                        }
                        return profile;
                    });

                    // Add the updated category to the results
                    acc[categoryKey] = {
                        ...category,
                        sites: updatedSites
                    };

                    return acc;
                }, {} as Record<string, { categoryName: string; sites: Account[] }>);

                return {
                    ...page,
                    results: updatedResults
                };
            });

            return {
                ...current,
                pages: updatedPages
            };
        });
    };

    return {
        exploreProfilesQuery,
        updateExploreProfile
    };
}

export function useSuggestedProfilesForUser(handle: string, limit = 3) {
    const queryClient = useQueryClient();
    const queryKey = QUERY_KEYS.suggestedProfiles(handle, limit);

    const suggestedHandles = Object.values(exploreSites).flatMap(category => category.sites);

    const suggestedProfilesQuery = useQuery({
        queryKey,
        async queryFn() {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            // Get more handles than we need initially, since some might be filtered out as blocked
            const fetchLimit = Math.min(limit * 2, suggestedHandles.length);

            return Promise.allSettled(
                suggestedHandles
                    .sort(() => Math.random() - 0.5)
                    .slice(0, fetchLimit)
                    .map(suggestedHandle => api.getAccount(suggestedHandle))
            ).then((results) => {
                const accounts = results
                    .filter((result): result is PromiseFulfilledResult<Account> => result.status === 'fulfilled')
                    .map(result => result.value)
                    // Filter out blocked accounts
                    .filter(account => !account.blockedByMe && !account.domainBlockedByMe);

                // Return only the requested limit of accounts after filtering
                return accounts.slice(0, limit);
            });
        }
    });

    const updateSuggestedProfile = (id: string, updated: Partial<Account>) => {
        // Update the suggested profiles stored in the suggested profiles query cache
        queryClient.setQueryData(queryKey, (current: Account[] | undefined) => {
            if (!current) {
                return current;
            }

            return current.map((item: Account) => {
                if (item.id === id) {
                    return {...item, ...updated};
                }

                return item;
            });
        });
    };

    return {suggestedProfilesQuery, updateSuggestedProfile};
}

function prependActivityToPaginatedCollection(
    queryClient: QueryClient,
    queryKey: string[],
    collection: 'posts' | 'data',
    activity: Activity
) {
    queryClient.setQueryData(queryKey, (current: {
        pages: Array<{
            [key: string]: Activity[]
        }>
    } | undefined) => {
        if (!current) {
            return current;
        }

        return {
            ...current,
            pages: current.pages.map((page, idx: number) => {
                if (idx === 0) {
                    return {
                        ...page,
                        [collection]: [activity, ...page[collection]]
                    };
                }
                return page;
            })
        };
    });
}

function addActivityToCollection(
    queryClient: QueryClient,
    queryKey: string[],
    collection: 'posts',
    activity: Activity,
    after?: string
) {
    queryClient.setQueryData(queryKey, (current: {
        [key: string]: Activity[]
    } | undefined) => {
        if (!current) {
            return current;
        }

        let afterIdx = 0;

        if (after) {
            afterIdx = current[collection].findIndex(item => item.id === after);

            if (afterIdx === -1) {
                return current;
            }
        }

        return {
            ...current,
            [collection]: [
                ...current[collection].slice(0, afterIdx + 1),
                activity,
                ...current[collection].slice(afterIdx + 1)
            ]
        };
    });
}

function updateActivityInPaginatedCollection(
    queryClient: QueryClient,
    queryKey: string[],
    collection: 'posts' | 'data',
    id: string,
    update: (activity: Activity) => Activity
) {
    queryClient.setQueryData(queryKey, (current: {
        pages: Array<{
            [key: string]: Activity[]
        }>
    } | undefined) => {
        if (!current) {
            return current;
        }

        return {
            ...current,
            pages: current.pages.map((page) => {
                return {
                    ...page,
                    [collection]: page[collection].map((item: Activity) => {
                        if (item.id === id) {
                            return update(item);
                        }
                        return item;
                    })
                };
            })
        };
    });
}

function updateActivityInCollection(
    queryClient: QueryClient,
    queryKey: string[],
    collection: 'posts',
    id: string,
    update: (activity: Activity) => Activity
) {
    queryClient.setQueryData(queryKey, (current: {
        [key: string]: Activity[]
    } | undefined) => {
        if (!current) {
            return current;
        }

        return {
            ...current,
            [collection]: current[collection].map((item: Activity) => {
                if (item.id === id) {
                    return update(item);
                }
                return item;
            })
        };
    });
}

function removeActivityFromPaginatedCollection(
    queryClient: QueryClient,
    queryKey: string[],
    collection: 'posts' | 'data',
    id: string
) {
    queryClient.setQueryData(queryKey, (current: {
        pages: Array<{
            [key: string]: Activity[]
        }>
    } | undefined) => {
        if (!current) {
            return current;
        }

        return {
            ...current,
            pages: current.pages.map((page) => {
                return {
                    ...page,
                    [collection]: page[collection].filter(item => item.id !== id)
                };
            })
        };
    });
}

function removeActivityFromCollection(
    queryClient: QueryClient,
    queryKey: string[],
    collection: 'posts',
    id: string
) {
    queryClient.setQueryData(queryKey, (current: {
        [key: string]: Activity[]
    } | undefined) => {
        if (!current) {
            return current;
        }

        return {
            ...current,
            [collection]: current[collection].filter((item: Activity) => item.id !== id)
        };
    });
}

function prepareNewActivity(activity: Activity) {
    return {
        ...activity,
        // Update the id of the activity to the id of the activity object
        // as this is the id that will be used to perform actions on the
        // activity (i.e like, delete, etc)
        id: activity.object.id,
        object: {
            ...activity.object,
            // Set the authored flag to true as we know this is an activity created
            // by the user but the returned activity object does not have this
            // flag set
            authored: true,
            // Set the URL property to be the id of the object as this is not
            // included in the object returned from the API
            url: activity.object.id,
            // Set the replyCount property to 0 so that it can be incremented
            replyCount: 0
        }
    };
}

export function useReplyMutationForUser(handle: string, actorProps?: ActorProperties) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn({inReplyTo, content, imageUrl}: {inReplyTo: string, content: string, imageUrl?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.reply(inReplyTo, content, imageUrl);
        },
        onMutate: ({inReplyTo, content, imageUrl}) => {
            if (!actorProps) {
                throw new Error('Cannot create reply without actor props');
            }

            const formattedContent = formatPendingActivityContent(content);

            const id = generatePendingActivityId();
            const activity = generatePendingActivity(actorProps, id, formattedContent, imageUrl);

            // Add pending activity to the thread after the inReplyTo post
            addActivityToCollection(queryClient, QUERY_KEYS.thread(inReplyTo), 'posts', activity, inReplyTo);

            // Increment the reply count of the inReplyTo post in the feed
            updateReplyCountInCache(queryClient, inReplyTo, 1);

            // Update reply count in notifications
            updateNotificationsReplyCountCache(queryClient, handle, inReplyTo, 1);

            // We do not need to increment the reply count of the inReplyTo post
            // in the thread as this is handled locally in the ArticleModal component

            return {id};
        },
        onSuccess: (activity: Activity, variables, context) => {
            if (activity.id === undefined) {
                throw new Error('Activity returned from API has no id');
            }

            const preparedActivity = prepareNewActivity(activity);

            updateActivityInCollection(queryClient, QUERY_KEYS.thread(variables.inReplyTo), 'posts', context?.id ?? '', () => preparedActivity);
        },
        onError(error: {message: string, statusCode: number}, variables, context) {
            // eslint-disable-next-line no-console
            console.error(error);

            // Remove the pending activity from the thread
            removeActivityFromCollection(queryClient, QUERY_KEYS.thread(variables.inReplyTo), 'posts', context?.id ?? '');

            // Decrement the reply count of the inReplyTo post in the feed
            updateReplyCountInCache(queryClient, variables.inReplyTo, -1);

            // Update reply count in notifications
            updateNotificationsReplyCountCache(queryClient, handle, variables.inReplyTo, -1);

            // We do not need to decrement the reply count of the inReplyTo post
            // in the thread as this is handled locally in the ArticleModal component

            if (error.statusCode === 403) {
                return toast.error('Action failed', {
                    description: 'This user has restricted who can interact with their account.'
                });
            }
            toast.error('An error occurred while sending your reply.');
        }
    });
}

export function useNoteMutationForUser(handle: string, actorProps?: ActorProperties) {
    const queryClient = useQueryClient();
    const queryKeyFeed = QUERY_KEYS.feed;
    const queryKeyOutbox = QUERY_KEYS.outbox(handle);
    const queryKeyPostsByAccount = QUERY_KEYS.profilePosts('index');

    return useMutation({
        async mutationFn({content, imageUrl}: {content: string, imageUrl?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.note(content, imageUrl);
        },
        onMutate: ({content, imageUrl}) => {
            if (!actorProps) {
                throw new Error('Cannot create note without actor props');
            }

            const formattedContent = formatPendingActivityContent(content);

            const id = generatePendingActivityId();
            const activity = generatePendingActivity(actorProps, id, formattedContent, imageUrl);

            prependActivityToPaginatedCollection(queryClient, queryKeyFeed, 'posts', activity);
            prependActivityToPaginatedCollection(queryClient, queryKeyOutbox, 'data', activity);

            // Add to profile tab (postsByAccount)
            prependActivityToPaginatedCollection(queryClient, queryKeyPostsByAccount, 'posts', activity);

            return {id};
        },
        onSuccess: (post: Post, _variables, context) => {
            if (post.id === undefined) {
                throw new Error('Post returned from API has no id');
            }
            const activity = mapPostToActivity(post);

            updateActivityInPaginatedCollection(queryClient, queryKeyFeed, 'posts', context?.id ?? '', () => activity);
            updateActivityInPaginatedCollection(queryClient, queryKeyOutbox, 'data', context?.id ?? '', () => activity);
            updateActivityInPaginatedCollection(queryClient, queryKeyPostsByAccount, 'posts', context?.id ?? '', () => activity);
        },
        onError(error, _variables, context) {
            // eslint-disable-next-line no-console
            console.error(error);

            removeActivityFromPaginatedCollection(queryClient, queryKeyFeed, 'posts', context?.id ?? '');
            removeActivityFromPaginatedCollection(queryClient, queryKeyOutbox, 'data', context?.id ?? '');
            removeActivityFromPaginatedCollection(queryClient, queryKeyPostsByAccount, 'posts', context?.id ?? '');

            toast.error('An error occurred while posting your note.');
        }
    });
}

export function useAccountForUser(handle: string, profileHandle: string) {
    return useQuery({
        queryKey: QUERY_KEYS.account(profileHandle === 'me' ? 'index' : profileHandle),
        async queryFn() {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);
            return api.getAccount(profileHandle);
        }
    });
}

export function useAccountFollowsForUser(profileHandle: string, type: AccountFollowsType) {
    return useInfiniteQuery({
        queryKey: QUERY_KEYS.accountFollows(profileHandle, type),
        async queryFn({pageParam}: {pageParam?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI('index', siteUrl);

            return api.getAccountFollows(profileHandle, type, pageParam);
        },
        getNextPageParam(prevPage) {
            return prevPage.next;
        }
    });
}

export function useFeedForUser(options: {enabled: boolean}) {
    const queryKey = QUERY_KEYS.feed;
    const queryClient = useQueryClient();

    const feedQuery = useInfiniteQuery({
        queryKey,
        enabled: options.enabled,
        staleTime: 1 * 60 * 1000, // 1m
        async queryFn({pageParam}: {pageParam?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI('index', siteUrl);
            return api.getFeed(pageParam).then((response) => {
                return {
                    posts: response.posts.map(mapPostToActivity),
                    next: response.next
                };
            });
        },
        getNextPageParam(prevPage) {
            return prevPage.next;
        }
    });

    const updateFeedActivity = (id: string, updated: Partial<Activity>) => {
        updateActivityInPaginatedCollection(
            queryClient,
            queryKey,
            'posts',
            id,
            activity => ({...activity, ...updated})
        );
    };

    return {feedQuery, updateFeedActivity};
}

export function useInboxForUser(options: {enabled: boolean}) {
    const queryKey = QUERY_KEYS.inbox;
    const queryClient = useQueryClient();

    const inboxQuery = useInfiniteQuery({
        queryKey,
        enabled: options.enabled,
        staleTime: 20 * 1000, // 20s
        async queryFn({pageParam}: {pageParam?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI('index', siteUrl);
            return api.getInbox(pageParam).then((response) => {
                return {
                    posts: response.posts.map(mapPostToActivity),
                    next: response.next
                };
            });
        },
        getNextPageParam(prevPage) {
            return prevPage.next;
        }
    });

    const updateInboxActivity = (id: string, updated: Partial<Activity>) => {
        updateActivityInPaginatedCollection(
            queryClient,
            queryKey,
            'posts',
            id,
            activity => ({...activity, ...updated})
        );
    };

    return {inboxQuery, updateInboxActivity};
}

export function usePostsByAccount(profileHandle: string, options: {enabled: boolean}) {
    const queryKey = QUERY_KEYS.profilePosts(profileHandle === 'me' ? 'index' : profileHandle);
    const queryClient = useQueryClient();

    const postsByAccountQuery = useInfiniteQuery({
        queryKey,
        enabled: options.enabled,
        async queryFn({pageParam}: {pageParam?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI('index', siteUrl);
            return api.getPostsByAccount(profileHandle, pageParam).then((response) => {
                return {
                    posts: response.posts.map(mapPostToActivity),
                    next: response.next
                };
            }).catch(() => {
                return {
                    posts: [],
                    next: null
                };
            });
        },
        getNextPageParam(prevPage) {
            return prevPage.next;
        }
    });

    const updatePostsByAccount = (id: string, updated: Partial<Activity>) => {
        updateActivityInPaginatedCollection(
            queryClient,
            queryKey,
            'posts',
            id,
            activity => ({...activity, ...updated})
        );
    };

    return {postsByAccountQuery, updatePostsByAccount};
}

export function usePostsLikedByAccount(options: {enabled: boolean}) {
    const queryKey = QUERY_KEYS.postsLikedByAccount;
    const queryClient = useQueryClient();

    const postsLikedByAccountQuery = useInfiniteQuery({
        queryKey,
        enabled: options.enabled,
        async queryFn({pageParam}: {pageParam?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI('index', siteUrl);
            return api.getPostsLikedByAccount(pageParam).then((response) => {
                return {
                    posts: response.posts.map(mapPostToActivity),
                    next: response.next
                };
            });
        },
        getNextPageParam(prevPage) {
            return prevPage.next;
        }
    });

    const updatePostsLikedByAccount = (id: string, updated: Partial<Activity>) => {
        updateActivityInPaginatedCollection(
            queryClient,
            queryKey,
            'posts',
            id,
            activity => ({...activity, ...updated})
        );
    };

    return {postsLikedByAccountQuery, updatePostsLikedByAccount};
}

export function useDeleteMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(mutationData: {id: string, parentId?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.delete(mutationData.id);
        },
        onMutate: ({id, parentId}) => {
            // Update the feed cache:
            // - Remove the post from the feed
            // - Decrement the reply count of the parent post if applicable
            const previousFeed = queryClient.getQueryData<{pages: {posts: Activity[]}[]}>(QUERY_KEYS.feed);

            queryClient.setQueryData(QUERY_KEYS.feed, (current?: {pages: {posts: Activity[]}[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {posts: Activity[]}) => {
                        return {
                            ...page,
                            posts: page.posts
                                .filter((item: Activity) => item.id !== id)
                                .map((item: Activity) => {
                                    if (item.object.id === parentId) {
                                        return {
                                            ...item,
                                            object: {
                                                ...item.object,
                                                replyCount: item.object.replyCount - 1
                                            }
                                        };
                                    }
                                    return item;
                                })
                        };
                    })
                };
            });

            // Update the inbox cache:
            // - Remove the post from the inbox
            // - Decrement the reply count of the parent post if applicable
            const previousInbox = queryClient.getQueryData<{pages: {posts: Activity[]}[]}>(QUERY_KEYS.inbox);

            queryClient.setQueryData(QUERY_KEYS.inbox, (current?: {pages: {posts: Activity[]}[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {posts: Activity[]}) => {
                        return {
                            ...page,
                            posts: page.posts
                                .filter((item: Activity) => item.id !== id)
                                .map((item: Activity) => {
                                    if (item.object.id === parentId) {
                                        return {
                                            ...item,
                                            object: {
                                                ...item.object,
                                                replyCount: item.object.replyCount - 1
                                            }
                                        };
                                    }
                                    return item;
                                })
                        };
                    })
                };
            });

            // Update the thread cache:
            // - Remove the post from the thread
            // - Decrement the reply count of the parent post if applicable
            const threadQueryKey = QUERY_KEYS.thread(null);
            const previousThreads = queryClient.getQueriesData<{posts: Activity[]}>(threadQueryKey);

            queryClient.setQueriesData(threadQueryKey, (current?: {posts: Activity[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    posts: current.posts.filter((activity: Activity) => activity.id !== id)
                        .map((activity: Activity) => {
                            if (activity.object.id === parentId) {
                                return {
                                    ...activity,
                                    object: {
                                        ...activity.object,
                                        replyCount: activity.object.replyCount - 1
                                    }
                                };
                            }
                            return activity;
                        })
                };
            });

            // Update reply count in notifications if this was a reply
            if (parentId) {
                updateNotificationsReplyCountCache(queryClient, handle, parentId, -1);
            }

            // Update the outbox cache:
            // - Remove the post from the outbox
            const outboxQueryKey = QUERY_KEYS.outbox(handle);
            const previousOutbox = queryClient.getQueryData<{pages: {data: Activity[]}[]}>(outboxQueryKey);

            queryClient.setQueryData(outboxQueryKey, (current?: {pages: {data: Activity[]}[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {data: Activity[]}) => {
                        return {
                            ...page,
                            data: page.data.filter((item: Activity) => item.object.id !== id)
                        };
                    })
                };
            });

            // Update the liked cache:
            // - Remove the post from the liked collection
            const likedQueryKey = QUERY_KEYS.liked(handle);
            const previousLiked = queryClient.getQueryData<{pages: {data: Activity[]}[]}>(likedQueryKey);
            let removedFromLiked = false;

            queryClient.setQueryData(likedQueryKey, (current?: {pages: {data: Activity[]}[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {data: Activity[]}) => {
                        removedFromLiked = page.data.some((item: Activity) => item.object.id === id);

                        return {
                            ...page,
                            data: page.data.filter((item: Activity) => item.object.id !== id)
                        };
                    })
                };
            });

            // Check if post was liked by checking all possible locations
            const wasLiked = [
                QUERY_KEYS.feed,
                QUERY_KEYS.inbox,
                QUERY_KEYS.profilePosts('index'),
                QUERY_KEYS.postsLikedByAccount
            ].some((key) => {
                const queryData = queryClient.getQueryData<{pages: {posts: Activity[]}[]}>(key);
                return queryData?.pages.some(page => page.posts.some(post => post.id === id && post.object.liked));
            });

            if (wasLiked) {
                queryClient.setQueryData(QUERY_KEYS.account(handle === 'me' ? 'index' : handle), (currentAccount?: Account) => {
                    if (!currentAccount) {
                        return currentAccount;
                    }
                    return {
                        ...currentAccount,
                        likedCount: Math.max(0, currentAccount.likedCount - 1)
                    };
                });
            }

            // Update the profile posts cache:
            // - Remove the post from any profile posts collections it may be in
            const profilePostsQueryKey = QUERY_KEYS.profilePosts(null);
            const previousProfilePosts = queryClient.getQueriesData<{pages: {posts: Activity[]}[]}>(profilePostsQueryKey);

            queryClient.setQueriesData(profilePostsQueryKey, (current?: {pages: {posts: Activity[]}[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {posts: Activity[]}) => {
                        return {
                            ...page,
                            posts: page.posts.filter((item: Activity) => item.object.id !== id)
                        };
                    })
                };
            });

            // Update the account cache:
            // - Decrement liked post count if the removed post was in the liked collection
            let accountQueryKey: string[] = [];
            let previousAccount: Account | undefined;

            if (removedFromLiked) {
                accountQueryKey = QUERY_KEYS.account(handle === 'me' ? 'index' : handle);
                previousAccount = queryClient.getQueryData<Account>(accountQueryKey);

                queryClient.setQueryData(accountQueryKey, (currentAccount?: {likedCount: number}) => {
                    if (!currentAccount) {
                        return currentAccount;
                    }

                    return {
                        ...currentAccount,
                        likedCount: currentAccount.likedCount - 1 < 0 ? 0 : currentAccount.likedCount - 1
                    };
                });
            }

            // Update the posts by account cache
            const postsByAccountKey = QUERY_KEYS.profilePosts('index');
            const previousPostsByAccount = queryClient.getQueryData<{pages: {posts: Activity[]}[]}>(postsByAccountKey);

            queryClient.setQueryData(postsByAccountKey, (current?: {pages: {posts: Activity[]}[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {posts: Activity[]}) => ({
                        ...page,
                        posts: page.posts.filter((item: Activity) => item.object.id !== id)
                    }))
                };
            });

            // Update the liked posts cache
            const postsLikedByAccountKey = QUERY_KEYS.postsLikedByAccount;
            const previousPostsLikedByAccount = queryClient.getQueryData<{pages: {posts: Activity[]}[]}>(postsLikedByAccountKey);

            queryClient.setQueryData(postsLikedByAccountKey, (current?: {pages: {posts: Activity[]}[]}) => {
                if (!current) {
                    return current;
                }

                return {
                    ...current,
                    pages: current.pages.map((page: {posts: Activity[]}) => ({
                        ...page,
                        posts: page.posts.filter((item: Activity) => item.object.id !== id)
                    }))
                };
            });

            return {
                previousFeed: {
                    key: QUERY_KEYS.feed,
                    data: previousFeed
                },
                previousInbox: {
                    key: QUERY_KEYS.inbox,
                    data: previousInbox
                },
                previousThreads: {
                    key: threadQueryKey,
                    data: previousThreads
                },
                previousOutbox: {
                    key: outboxQueryKey,
                    data: previousOutbox
                },
                previousLiked: {
                    key: likedQueryKey,
                    data: previousLiked
                },
                previousProfilePosts: {
                    key: profilePostsQueryKey,
                    data: previousProfilePosts
                },
                previousAccount: removedFromLiked ? {
                    key: accountQueryKey,
                    data: previousAccount
                } : null,
                previousPostsByAccount: {
                    key: QUERY_KEYS.profilePosts('index'),
                    data: previousPostsByAccount
                },
                previousPostsLikedByAccount: {
                    key: QUERY_KEYS.postsLikedByAccount,
                    data: previousPostsLikedByAccount
                }
            };
        },
        onError: (_err, _variables, context) => {
            if (!context) {
                return;
            }

            queryClient.setQueryData(context.previousFeed.key, context.previousFeed.data);
            queryClient.setQueryData(context.previousInbox.key, context.previousInbox.data);
            queryClient.setQueriesData(context.previousThreads.key, context.previousThreads.data);
            queryClient.setQueryData(context.previousOutbox.key, context.previousOutbox.data);
            queryClient.setQueryData(context.previousLiked.key, context.previousLiked.data);
            queryClient.setQueriesData(context.previousProfilePosts.key, context.previousProfilePosts.data);

            if (context.previousAccount) {
                queryClient.setQueryData(context.previousAccount.key, context.previousAccount.data);
            }

            if (context.previousPostsByAccount) {
                queryClient.setQueryData(QUERY_KEYS.profilePosts('index'), context.previousPostsByAccount);
            }
            if (context.previousPostsLikedByAccount) {
                queryClient.setQueryData(QUERY_KEYS.postsLikedByAccount, context.previousPostsLikedByAccount);
            }
        }
    });
}

export function useNotificationsForUser(handle: string) {
    return useInfiniteQuery({
        queryKey: QUERY_KEYS.notifications(handle),
        async queryFn({pageParam}: {pageParam?: string}) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.getNotifications(pageParam);
        },
        getNextPageParam(prevPage) {
            return prevPage.next;
        }
    });
}

export function useReplyChainForUser(handle: string, postApId: string | null) {
    const [replyChain, setReplyChain] = useState<ReplyChainResponse | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        if (!postApId) {
            setIsLoading(false);
            return;
        }

        let cancelled = false;

        async function fetchReplyChain() {
            try {
                setIsLoading(true);
                setError(null);

                const siteUrl = await getSiteUrl();
                const api = createActivityPubAPI(handle, siteUrl);
                const response = await api.getReplies(postApId!);

                if (!cancelled) {
                    setReplyChain(response);
                    setIsLoading(false);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err : new Error('Failed to fetch reply chain'));
                    setIsLoading(false);
                }
            }
        }

        fetchReplyChain();

        return () => {
            cancelled = true;
        };
    }, [handle, postApId]);

    const loadMoreAncestors = useCallback(async () => {
        if (!replyChain?.ancestors.hasMore || !replyChain?.ancestors.chain[0]) {
            return;
        }

        try {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            const nextPage = await api.getReplies(replyChain.ancestors.chain[0].id);

            setReplyChain((prev) => {
                if (!prev) {
                    return prev;
                }
                return {
                    ...prev,
                    ancestors: {
                        chain: [...nextPage.ancestors.chain, ...prev.ancestors.chain],
                        hasMore: nextPage.ancestors.hasMore
                    }
                };
            });
        } catch (err) {
            setError(err instanceof Error ? err : new Error('Failed to load more ancestors'));
        }
    }, [handle, replyChain?.ancestors.hasMore, replyChain?.ancestors.chain]);

    const loadMoreChildren = useCallback(async () => {
        if (!replyChain?.next) {
            return;
        }
        if (!postApId) {
            return;
        }

        try {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            const nextPage = await api.getReplies(postApId, replyChain.next);

            setReplyChain((prev) => {
                if (!prev) {
                    return prev;
                }
                return {
                    ...prev,
                    children: [...prev.children, ...nextPage.children],
                    next: nextPage.next
                };
            });
        } catch (err) {
            setError(err instanceof Error ? err : new Error('Failed to load more children'));
        }
    }, [handle, replyChain?.next, postApId]);

    const loadMoreChildReplies = useCallback(async (childIndex: number) => {
        if (!replyChain?.children[childIndex]?.hasMore) {
            return;
        }

        try {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);
            const child = replyChain.children[childIndex];

            // Use the second-to-last reply as the starting point for pagination
            // This ensures we get proper continuity without gaps
            const replyForPagination = child.chain.length > 1
                ? child.chain[child.chain.length - 2]
                : child.post;

            const nextPage = await api.getReplies(replyForPagination.id);

            const moreReplies = nextPage.children[0].chain;

            setReplyChain((prev) => {
                if (!prev) {
                    return prev;
                }
                const newChildren = [...prev.children];
                newChildren[childIndex] = {
                    ...child,
                    chain: [...child.chain, ...moreReplies],
                    hasMore: nextPage.children[0].hasMore
                };
                return {
                    ...prev,
                    children: newChildren
                };
            });
        } catch (err) {
            setError(err instanceof Error ? err : new Error('Failed to load more child replies'));
        }
    }, [handle, replyChain]);

    return {
        data: replyChain,
        isLoading,
        error,
        loadMoreAncestors,
        loadMoreChildren,
        loadMoreChildReplies,
        hasMoreAncestors: !!replyChain?.ancestors.hasMore,
        hasMoreChildren: !!replyChain?.next,
        hasMoreChildReplies: (childIndex: number) => !!replyChain?.children[childIndex]?.hasMore
    };
}

export function useUpdateAccountMutationForUser(handle: string) {
    const queryClient = useQueryClient();

    return useMutation({
        async mutationFn(data: {
            name: string;
            username: string;
            bio: string;
            avatarUrl: string;
            bannerImageUrl: string;
        }) {
            const siteUrl = await getSiteUrl();
            const api = createActivityPubAPI(handle, siteUrl);

            return api.updateAccount(data);
        },
        onSuccess() {
            queryClient.invalidateQueries({
                queryKey: QUERY_KEYS.account('index')
            });
        }
    });
}

export async function uploadFile(file: File) {
    const siteUrl = await getSiteUrl();
    const api = createActivityPubAPI('index', siteUrl);
    return api.upload(file);
}

export function useNotificationsCountForUser(handle: string) {
    const siteUrl = useCallback(async () => await getSiteUrl(), []);
    const api = useCallback(async () => {
        const url = await siteUrl();
        return createActivityPubAPI(handle, url);
    }, [handle, siteUrl]);

    return useQuery({
        queryKey: QUERY_KEYS.notificationsCount(handle),
        async queryFn() {
            const activityPubAPI = await api();
            const response = await activityPubAPI.getNotificationsCount();
            return response.count;
        }
    });
}

export function useResetNotificationsCountForUser(handle: string) {
    const queryClient = useQueryClient();
    const siteUrl = useCallback(async () => await getSiteUrl(), []);
    const api = useCallback(async () => {
        const url = await siteUrl();
        return createActivityPubAPI(handle, url);
    }, [handle, siteUrl]);

    return useMutation({
        async mutationFn() {
            // Clear the count in the cache
            queryClient.setQueryData(QUERY_KEYS.notificationsCount(handle), 0);
            const activityPubAPI = await api();
            return activityPubAPI.resetNotificationsCount();
        }
    });
}
