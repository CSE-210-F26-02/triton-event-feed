# Team 2 Product Requirements Docs (PRD)

> [!INFO]
> Updated from docs at 11/7/2026 15:30 PST

> [!NOTE]
> I want to start by saying that this doc is subject to change.     We will for sure not know everything necessary currently; it's just a template to plan the project and think about our users, features, and potential challenges we may face. It is also a place to set some goals and requirements for our product 

**Table of Contents**

[**Section 1 Overview And Summary:	2**](#section-1-overview-and-summary:)

[1.1 About The Team	2](#1.1-about-the-team)

[1.2 Problem Statement	2](#1.2-problem-statement)

[1.3 Our Product/Solution	3](#1.3-our-product/solution)

[**Section 2: Target Userbase:	3**](#section-2:-target-user-base:)

[2.1 Primary Audience	3](#2.1-primary-audience)

[2.2 Secondary Audience	3](#2.2-secondary-audience)

[**Section 3: Goals:	3**](#section-3:-goals:)

[3.1 Product Goals	3](#3.1-product-goals)

[3.2 KPI & Metrics	4](#3.2-kpi-&-metrics)

[3.3 Core Scope & Features (MVP)	4](#3.3-core-scope-&-features-\(mvp\))

[3.4 Additional Nice to Have	4](#3.4-additional-nice-to-have)

[4.1 User Stories	4](#4.1-user-stories)

[4.2 User Experiences and Design Priorities	5](#4.2-user-experiences-and-design-priorities)

[4.3 Functional Requirements	5](#4.3-functional-requirements)

[4.4 Non-Functional Requirements	5](#4.4-non-functional-requirements)

[5.1 Primary Constraints	5](#5.1-primary-constraints)

[5.2 Secondary Constraints	6](#5.2-secondary-constraints)

[5.3 Risks	6](#5.3-risks)

# Section 1 Overview And Summary: {#section-1-overview-and-summary:}

## 1.1 About The Team {#1.1-about-the-team}

**Team Manager**: Jared Ziv  
**Team Leads**: Brian Kwong, Gage Wrye  
**Developers**: Charlie Herbert, David Lu, Jessie Zhang, Jooahn Park, Kai Wang, Nathan Tewinpagti

## 1.2 Problem Statement {#1.2-problem-statement}

Sharing data related to locations can be challenging to do in a convenient manner. Many platforms exist that cater to businesses, though small, community-focused platforms that invite user contributions beyond just reviews are less common.

## 1.3 Our Product/Solution {#1.3-our-product/solution}

Description:

Our goal is to create a platform for community maps on the AT Protocol. These maps would present user-contributed events and other points of interest based on proximity, with options for filtering and grouping events.

## 1.3 Our Opportunity {#1.3-our-opportunity}

# Section 2: Target User-base: {#section-2:-target-user-base:}

## 2.1 Primary Audience

Who they are, what they do, what they know

Our primary users will be students and campus organizations.

They will range in age between 18 and 25 and primary objectives are to discover and participate in campus events.

You can find some example user personas below in [Section 4](#section-4:-user-stories-and-experiences:).

## 2.2 Secondary Audience {#2.2-secondary-audience}

Our secondary users will be local community members and small businesses who are interested in promoting their events and services within the campus area.

We also hope to expand the app beyond a university campus, such as discovering local events in cities.

# Section 3: Goals {#section-3:-goals:}

## 3.1 Product Goals {#3.1-product-goals}

- Students can find clubs and pop-ups, events, etc. around UCSD  
- Students are able to subscribe to different POIs depending on what they are interested in  
- Posted events should be able to expire gracefully  
- Be able to import events from different data sources

		  
### 3.1.1 How do we measure product success?

- High number of users/events posted on our platform  
- Limited number of defects, though each release of our product  
- High user satisfaction and user retention on the platform  
- The project should have regular releases, and reported defects should be resolved quickly (within a reasonable) amount of time, depending on severity and complexity of issue.  
- The application can adapt to work in less-than-ideal internet conditions 


### 3.1.2 What metrics would we like to collect both during development and when our application is released 

- Peak/Average number of daily users  
- Peak/Average number of events daily (also in a sliding window, e.g. average number of events in the past 7 days)  
- Percentage of campus orgs that are utilizing our platform  
- Average percentage of club members   
- Daily growth of number of POI available on the platform  
- Average load time of our site on stable internet, weak internet, and a slow congested cellular network  
- Average time for a new post to propagate across the network  
- Number of bug reports added daily  
- Average number of outstanding issues (known defects) 

### 3.1.3 What are some key milestones we want to achieve

## 3.2 KPI & Metrics {#3.2-kpi-&-metrics}

Define the metrics outlined in 3.1  
What metrics do we value the most, and what is that amount  
What goal does metric X help in 3.1

## 3.3 Core Scope & Features (MVP) {#3.3-core-scope-&-features-(mvp)} 

- Users ability to discover new events through a curated feed
- Event hooters can post events with a time window and location, 
- Users can subscribe to events and receive updates when the event information is modified
- Events should have tags and be able to be grouped, so that users can filter events based on their interests

## 3.4 Additional Nice to Have {#3.4-additional-nice-to-have}

None (as of now)

# Section 4. User Stories, Acceptance Criteria & Requirements

## 4.1 User Stories {#4.1-user-stories}

| User | What They Want to Do | Acceptance Criteria  |
| :---- | :---- | :---- |
| Host Henry | Plan and organize an event across multiple, potentially disparate platforms. | Needs to be able to easily sync information across different platforms, such as posts from Bluesky.  |
| Tourist Timmy | While visiting a new city, they see an event they’re interested in, but don’t know how to reach. They’re familiar with other map apps, and would like to use one to plan a route to the destination. | Needs to be able to conveniently export event locations to other services with route planning functionality. |
| Last-minute Larry | Planned a party at a public park, but had to change locations last minute since all the tables were taken. | Needs to be able to update event listing and have that update be delivered to attendees quickly. Might want to consider push notifications and ability to ‘subscribe’ to events. |

## 4.2 User Experiences and Design Priorities {#4.2-user-experiences-and-design-priorities}

## 4.3 Functional Requirements  {#4.3-functional-requirements}

- Events/POIs are displayed on a map at their specified locations

- Events/POIs can be assigned groups, which can be used to filter displayed data

    - [https\://atproto.com/guides/feeds](https://atproto.com/guides/feeds) 
    
- Events can have a time window/expiry date and are automatically removed from the system after that date

- Events can be subscribed to so that users receive updates when the event information is modified  

- Users can set up ‘listeners’ to automatically update their event postings with information from other AT Protocol services.

## 4.4 Non-Functional Requirements {#4.4-non-functional-requirements}

- Security: In the future, if we decide to add private events, make sure they're secure

- Performance:  

  - Site needs to work well in poor WiFI environments; we all know the state of UCSD internet😭

  - Should be mobile-friendly, especially on the map side.  People most likely would be

- Reliability: 

  - Site has to have high availability; people won't want to use it if it is always down.
  
### 4.4.1 Ranking (Priority) of Non-Functional Requirements
1. Maintainability  
   1. Should include Testability under TDD  
   2. Modularity helps with this  
2. Functional Suitability ([Link](https://iso25000.com/en/iso-25000-standards/iso-25010))  
   1. Accuracy & Completeness  
3. Performance  
   1. Event/POI updates should be handled quickly, so that users are not given out-of-date information.  
4. Reliability
  - Should be able to handle a large number of users and events without crashing.
  - Site should have a  strong uptime or else users would not want to use it.
5. Accessibility
  - Is the site accessible to users with disabilities?  We should consider this in our design.  Accessibility also means can the site work even if parts of it are down. We should aim for as much accessibility as possible, but this is not a priority for the MVP.
6. Security
  - (FUTURE) If we decide to add private events, make sure they're secure and private.  This is not a priority for the MVP, but we should consider it in our design.
7. Configurability  
   1. Allow users to filter events/POIs.  
8. Interoperability/Compatibility  
   1. Should be able to work with other AT Protocol services.  

### 4.4.2 Other Non-Functional Requirements (Non Priority)

* Scalability  
  * Maybe have some consideration of this in our program architecture, but not a main goal.  
* Portability  
  * Should test on mobile devices and PCs, though not a focus beyond that.  
* Flexibility  
  * Sort of redundant with Maintainability \+ Modularity

# Section 5 Constraints & Risk

## 5.1 Primary Constraints {#5.1-primary-constraints}

- We have to use AT  
- Limited time: \~150 hrs total  
- ~~Understanding how to integrate with other services~~ 

## 5.1.1 Additional Primary Constraints

## 5.2 Secondary Constraints {#5.2-secondary-constraints}

- User sharing  
- Hosting of the application; hosting an online service can get expensive.  Try to get the free Azure or GCP credit or stick to the free tier of Vercel, Rainway, GH or Cloudflare, etc.

## 5.3 Risks {#5.3-risks}

For each risk 

1. Explain Each Risk  
2. Their Potential Impact  
3. How can we avoid or (at least minimize) them

	
* Detecting and preventing fake locations or events  
  * Users may upload incorrect information, either unintentionally or maliciously.  
  * If fake locations/events become prevalent enough, users may lose trust in the app and look elsewhere  
  * Could potentially protect against with proof of location or booking; try to verify as many sources as possible  
  * May consider a user trust score  
* User location if they are searching for places nearby, potential attack vector  
  * When querying for nearby events, the user’s location may be broadcast depending on our implementation.  
  * If associated with personal information, this could present a security risk.  
  * We might want some way of obfuscating or at least generalizing the request source while in transit.  
* Handle location data responsibility; we shouldn’t need to store it  
* Breaking compatibility between versions, depending on event data scheme  
  * If revised data types aren’t backwards compatible, may lose user data  
  * Alternatively, may be burdened with continuing to support bad initial decisions if not considered carefully  
  * AT Specifications: [https\://atproto.com/specs/lexicon\#lexicon-evolution](https://atproto.com/specs/lexicon#lexicon-evolution)   
  * Can’t predict the future, but careful planning is warranted  
* Content size and moderation  
  * If images are allowed in event listings, file storage on PDSs may be a concern.  
    * Relevant for any large data types: [https\://atproto.com/guides/images-and-video](https://atproto.com/guides/images-and-video)   
  * Additionally, user-submitted content could be offensive/inappropriate.  
  * Limited resources on our end for moderation/storage; likely need to pass these off to the users. Provide tools for blocking users, perhaps minimum trust score?  

## 5.4 Dependencies  
	
- Outline what dependencies we settle with, and justification for each.  Can also link to ADR if we make key decisions  
-   
  - Overture for map data (Ideally making it modular so users can also expand to use OpenStreetMap). Google Maps API gets expensive quickly.  We’re also trying to decentralize the platform. We do not have the resources to map out all the different places around the campus (and especially beyond).  That's a lot of work  
  - Leaflet, lightweight, performance-oriented open-source JS mapping library.  Again, developing a whole mapping lib is a project of its own with many peculiarities.  Use what's existing; it has many plugins if we need them, or we can even develop our own :)  
  - Not sure if we want to use a frontend library framework; need to discuss this at the next meeting

## Section 6. Decisions and Questions:

- Outline any core decisions made throughout the design and development process  
- Outline questions we may have and answer as we go along 